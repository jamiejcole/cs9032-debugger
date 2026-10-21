import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { BuildResult, Diagnostic } from './types';

const MAC = process.platform === 'darwin';

/** Homebrew's avra on macOS, else whatever `avra` is on PATH. */
export const DEFAULT_AVRA = MAC ? '/opt/homebrew/bin/avra' : 'avra';
/** avra's compiled-in include dir; `.include "m2560def.inc"` resolves there first. */
export const AVRA_BUILTIN_INC: string[] = MAC ? ['/opt/homebrew/Cellar/avra/1.4.2/include/avr'] : [];

/**
 * Where m2560def.inc is for this avra: homebrew's share dir on macOS, else `includes/` of a
 * source build (avra at `<repo>/src/avra.exe`).
 */
export function defaultIncludeDirs(avra = DEFAULT_AVRA): string[] {
  if (MAC) return ['/opt/homebrew/share/avra'];
  const exe = path.isAbsolute(avra) ? avra : which(avra);
  return exe ? [path.resolve(path.dirname(exe), '..', 'includes')] : [];
}

function which(cmd: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const f = path.join(dir, cmd + ext);
      if (dir && existsSync(f)) return f;
    }
  }
  return undefined;
}

// "task2.asm(37) : Error   : Unknown mnemonic/macro: foo"
const DIAG = /^(.+?)\((\d+)\)\s*:\s*(Error|Warning)\s*:\s*(.*)$/i;

export function parseAvraOutput(output: string, cwd: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = DIAG.exec(line.trim());
    if (m) out.push({
      file: path.resolve(cwd, m[1]), line: +m[2],
      severity: m[3].toLowerCase() === 'error' ? 'error' : 'warning', message: m[4].trim(),
    });
  }
  return out;
}

/** Assemble `asmPath` next to itself. Writes .hex, .eep.hex, .obj, .map. */
export function assemble(asmPath: string, opts: { avra?: string; includeDirs?: string[] } = {}): Promise<BuildResult & { mapPath: string }> {
  const dir = path.dirname(asmPath);
  const base = path.basename(asmPath, path.extname(asmPath));
  const p = (ext: string) => path.join(dir, base + ext);
  const args = [...(opts.includeDirs ?? defaultIncludeDirs(opts.avra)).flatMap((d) => ['-I', d]),
    '-fI', path.basename(asmPath), '-o', p('.hex'), '-e', p('.eep.hex'), '-d', p('.obj'), '-m', p('.map')];
  return new Promise((resolve) => {
    execFile(opts.avra ?? DEFAULT_AVRA, args, { cwd: dir }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ ok: false, diagnostics: [], output: `avra not found at ${opts.avra ?? DEFAULT_AVRA}`, mapPath: p('.map') });
        return;
      }
      const diagnostics = parseAvraOutput(output, dir);
      resolve({
        ok: !err && !diagnostics.some((d) => d.severity === 'error'),
        hexPath: p('.hex'), eepPath: p('.eep.hex'), objPath: p('.obj'), mapPath: p('.map'),
        diagnostics, output,
      });
    });
  });
}
