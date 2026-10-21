import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { AvrDebugSession } from './debug/session';
import { flash, listSerialPorts, DEFAULT_AVRDUDE } from './toolchain/avrdude';
import { assemble, DEFAULT_AVRA, defaultIncludeDirs } from './toolchain/avra';
import type { Diagnostic } from './toolchain/types';
import { Panel } from './ui/panel';

const TYPE = 'avr';

export function activate(ctx: vscode.ExtensionContext): void {
  const diags = vscode.languages.createDiagnosticCollection('avra');
  const out = vscode.window.createOutputChannel('AVR');
  const panel = new Panel(ctx.extensionUri, (msg) => vscode.debug.activeDebugSession?.type === TYPE
    && vscode.debug.activeDebugSession.customRequest('avr/ui', msg));

  const showDiagnostics = (program: string, list: Diagnostic[]) => {
    diags.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of list) {
      const range = new vscode.Range(d.line - 1, 0, d.line - 1, Number.MAX_SAFE_INTEGER);
      const sev = d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      const arr = byFile.get(d.file) ?? [];
      arr.push(Object.assign(new vscode.Diagnostic(range, d.message, sev), { source: 'avra' }));
      byFile.set(d.file, arr);
    }
    for (const [f, arr] of byFile) diags.set(vscode.Uri.file(f), arr);
    if (list.some((d) => d.severity === 'error')) vscode.commands.executeCommand('workbench.actions.view.problems');
  };

  ctx.subscriptions.push(
    diags, out,
    vscode.debug.registerDebugAdapterDescriptorFactory(TYPE, {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new AvrDebugSession()),
    }),
    vscode.debug.registerDebugConfigurationProvider(TYPE, {
      resolveDebugConfiguration(folder, config) {
        // F5 with no launch.json: debug the open .asm file.
        if (!config.type && !config.request) {
          const doc = vscode.window.activeTextEditor?.document;
          if (doc?.fileName.endsWith('.asm')) {
            Object.assign(config, { type: TYPE, request: 'launch', name: 'Debug AVR', program: doc.fileName });
          }
        }
        if (!config.program) {
          vscode.window.showErrorMessage('Open an .asm file (or set "program" in launch.json) to debug.');
          return undefined;
        }
        const cfg = vscode.workspace.getConfiguration('avr');
        config.avra ??= cfg.get('avraPath') || DEFAULT_AVRA;
        config.includeDirs ??= includeDirs(cfg, config.avra);
        config.realtime ??= cfg.get('realtime', true);
        config.board = { ...readBoardFile(folder), ...config.board };
        return config;
      },
    }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
      if (e.session.type !== TYPE) return;
      if (e.event === 'avr/diagnostics') showDiagnostics(e.body.program, e.body.diagnostics);
      if (e.event === 'avr/ui') panel.post(e.body);
    }),
    vscode.debug.onDidStartDebugSession((s) => { if (s.type === TYPE) panel.show(); }),
    vscode.debug.onDidTerminateDebugSession((s) => { if (s.type === TYPE) panel.post({ type: 'ended' }); }),

    vscode.commands.registerCommand('avr.showPanel', () => panel.show()),
    vscode.commands.registerCommand('avr.toggleRealtime', async () => {
      const s = vscode.debug.activeDebugSession;
      const cfg = vscode.workspace.getConfiguration('avr');
      const next = !cfg.get('realtime', true);
      await cfg.update('realtime', next, vscode.ConfigurationTarget.Global);
      if (s?.type === TYPE) await s.customRequest('avr/setRealtime', { realtime: next });
      vscode.window.setStatusBarMessage(`AVR: ${next ? 'real-time (16 MHz)' : 'max speed'}`, 3000);
    }),
    vscode.commands.registerCommand('avr.resetStopwatch', () => {
      const s = vscode.debug.activeDebugSession;
      if (s?.type === TYPE) s.customRequest('avr/resetStopwatch');
    }),
    vscode.commands.registerCommand('avr.flash', async () => {
      const asm = vscode.window.activeTextEditor?.document.fileName;
      if (!asm?.endsWith('.asm')) return vscode.window.showErrorMessage('Open the .asm file to flash.');
      await vscode.window.activeTextEditor!.document.save();
      const cfg = vscode.workspace.getConfiguration('avr');
      const avra = cfg.get<string>('avraPath') || DEFAULT_AVRA;
      const r = await assemble(asm, { avra, includeDirs: includeDirs(cfg, avra) });
      showDiagnostics(asm, r.diagnostics);
      if (!r.ok) return vscode.window.showErrorMessage('Assembly failed, see Problems.');
      const port = await pickPort(ctx);
      if (!port) return;
      out.show(true);
      out.appendLine(`Flashing ${path.basename(r.hexPath!)} to ${port}...`);
      const ok = await flash(r.hexPath!, port, (s) => out.append(s), cfg.get('avrdudePath') || DEFAULT_AVRDUDE);
      if (ok) vscode.window.showInformationMessage(`Flashed ${path.basename(r.hexPath!)} to ${port}`);
      else vscode.window.showErrorMessage('avrdude failed, see the AVR output. Is the board plugged in and not open in a serial monitor?');
    }),
  );
}

export function deactivate(): void {}

async function pickPort(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  const ports = listSerialPorts();
  const remembered = ctx.workspaceState.get<string>('avr.port');
  if (remembered && ports.includes(remembered)) return remembered;
  if (ports.length === 0) { vscode.window.showErrorMessage('No board found (no serial ports).'); return; }
  const port = ports.length === 1 ? ports[0] : await vscode.window.showQuickPick(ports, { placeHolder: 'Serial port of the board' });
  if (port) await ctx.workspaceState.update('avr.port', port);
  return port;
}

/** The avr.includeDir setting, else the include dir that goes with this avra. */
function includeDirs(cfg: vscode.WorkspaceConfiguration, avra: string): string[] {
  const dir = cfg.get<string>('includeDir');
  return dir ? [dir] : defaultIncludeDirs(avra);
}

function readBoardFile(folder: vscode.WorkspaceFolder | undefined): object {
  const f = folder && path.join(folder.uri.fsPath, '.vscode', 'avr-board.json');
  if (!f || !existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) {
    vscode.window.showWarningMessage(`Ignoring .vscode/avr-board.json: ${(e as Error).message}`);
    return {};
  }
}
