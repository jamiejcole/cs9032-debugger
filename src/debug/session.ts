// DAP session: maps requests onto Engine/AvrSim/toolchain. No `vscode` import, so it runs
// inline in the extension host and under @vscode/debugadapter-testsupport.
import {
  BreakpointEvent, Event, InitializedEvent, LoggingDebugSession, OutputEvent, Scope, Source,
  StackFrame, StoppedEvent, TerminatedEvent, Thread,
} from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { AvrSim } from '../sim/avr';
import { Board, DEFAULT_BOARD } from '../board';
import type { BoardConfig } from '../board/types';
import { assemble, DEFAULT_AVRA, DEFAULT_INCLUDE } from '../toolchain/avra';
import { ObjSourceMap } from '../toolchain/obj';
import { AsmSymbols } from '../toolchain/symbols';
import type { Diagnostic } from '../toolchain/types';
import type { FromWebview, ToWebview } from '../ui/protocol';
import { Engine, type Stop } from './engine';
import { evaluate, fmtByte, fmtWord, hex, parseNumber } from './expr';
import { ioGroups } from './io';

export interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
  program: string;
  stopOnEntry?: boolean;
  realtime?: boolean;
  board?: BoardConfig;
  avra?: string;
  includeDirs?: string[];
}

/** Custom events the extension listens for. */
export type AvrEvent =
  | { event: 'avr/diagnostics'; body: { program: string; diagnostics: Diagnostic[] } }
  | { event: 'avr/ui'; body: ToWebview };

const THREAD = 1;
const enum Ref { Registers = 1, Status, Time }
const FLAGS = ['C', 'Z', 'N', 'V', 'S', 'H', 'T', 'I'];
// avra's built-in include dir; `.include "m2560def.inc"` resolves there first.
const AVRA_BUILTIN_INC = '/opt/homebrew/Cellar/avra/1.4.2/include/avr';

export class AvrDebugSession extends LoggingDebugSession {
  private engine?: Engine;
  private board?: Board;
  private args?: LaunchArgs;
  private configDone!: Promise<void>;
  private resolveConfigDone!: () => void;
  private srcBreakpoints = new Map<string, DebugProtocol.SourceBreakpoint[]>();

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.configDone = new Promise((r) => (this.resolveConfigDone = r));
  }

  protected initializeRequest(res: DebugProtocol.InitializeResponse): void {
    res.body = {
      supportsConfigurationDoneRequest: true,
      supportsFunctionBreakpoints: true,
      supportsSetVariable: true,
      supportsRestartRequest: true,
      supportsReadMemoryRequest: true,
      supportsWriteMemoryRequest: true,
      supportsEvaluateForHovers: true,
      supportsSteppingGranularity: true,
      supportsTerminateRequest: true,
    };
    this.sendResponse(res);
  }

  protected configurationDoneRequest(res: DebugProtocol.ConfigurationDoneResponse): void {
    this.resolveConfigDone();
    this.sendResponse(res);
  }

  protected async launchRequest(res: DebugProtocol.LaunchResponse, args: LaunchArgs): Promise<void> {
    this.args = args;
    const err = await this.build();
    if (err) return this.sendErrorResponse(res, 1, err);
    // Breakpoints can only be resolved once we have a source map, so announce readiness now.
    this.sendEvent(new InitializedEvent());
    await this.configDone;
    this.sendResponse(res);
    if (args.stopOnEntry ?? true) this.stopped({ reason: 'entry' });
    else this.go(this.engine!.continue(false));
  }

  /** Assemble and load. Returns an error message on failure. */
  private async build(): Promise<string | undefined> {
    const args = this.args!;
    const program = path.resolve(args.program);
    if (!existsSync(program)) return `Program not found: ${program}`;
    const includeDirs = args.includeDirs ?? [DEFAULT_INCLUDE];
    const r = await assemble(program, { avra: args.avra ?? DEFAULT_AVRA, includeDirs });
    this.custom({ event: 'avr/diagnostics', body: { program, diagnostics: r.diagnostics } });
    if (!r.ok) {
      this.sendEvent(new OutputEvent(`${r.output}\n`, 'stderr'));
      const first = r.diagnostics.find((d) => d.severity === 'error');
      return first ? `Assembly failed: ${path.basename(first.file)}:${first.line}: ${first.message}` : `Assembly failed:\n${r.output}`;
    }
    const sim = this.engine?.sim ?? new AvrSim();
    const eep = existsSync(r.eepPath!) ? readFileSync(r.eepPath!, 'utf8') : undefined;
    sim.load(readFileSync(r.hexPath!, 'utf8'), eep);
    const map = new ObjSourceMap(r.objPath!, path.dirname(program));
    const syms = new AsmSymbols(program, readFileSync(r.mapPath, 'utf8'), [...includeDirs, AVRA_BUILTIN_INC]);
    const old = this.engine;
    this.engine = new Engine(sim, map, syms);
    if (old) { this.engine.realtime = old.realtime; }
    else this.engine.realtime = args.realtime ?? true;
    this.engine.onTick = () => this.pushUi();
    if (!this.board) {
      this.board = new Board(sim.pins, { ...DEFAULT_BOARD, ...args.board }, { cycles: () => sim.cycles, hz: sim.clockHz });
    }
    for (const [file, bps] of this.srcBreakpoints) this.resolveBreakpoints(file, bps);
    return undefined;
  }

  // ---- execution ----------------------------------------------------------------------

  private go(p: Promise<Stop>): void {
    this.pushUi();
    p.then((s) => this.stopped(s), (e) => this.stopped({ reason: 'exception', text: String(e) }));
  }

  private stopped(s: Stop): void {
    if (s.reason === 'exception' && s.text) this.sendEvent(new OutputEvent(`${s.text}\n`, 'stderr'));
    const ev = new StoppedEvent(s.reason, THREAD, s.text) as DebugProtocol.StoppedEvent;
    ev.body.allThreadsStopped = true;
    this.sendEvent(ev);
    this.pushUi();
  }

  private busy(res: DebugProtocol.Response): boolean {
    if (!this.engine) { this.sendErrorResponse(res, 2, 'Not launched'); return true; }
    if (this.engine.running) { this.sendErrorResponse(res, 3, 'Target is running'); return true; }
    return false;
  }

  protected continueRequest(res: DebugProtocol.ContinueResponse): void {
    if (this.busy(res)) return;
    res.body = { allThreadsContinued: true };
    this.sendResponse(res);
    this.go(this.engine!.continue());
  }

  protected nextRequest(res: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    if (this.busy(res)) return;
    this.sendResponse(res);
    const e = this.engine!;
    this.go(args.granularity === 'instruction' ? e.stepInstructionAsync() : e.stepOver());
  }

  protected stepInRequest(res: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    if (this.busy(res)) return;
    this.sendResponse(res);
    const e = this.engine!;
    this.go(args.granularity === 'instruction' ? e.stepInstructionAsync() : e.stepIn());
  }

  protected stepOutRequest(res: DebugProtocol.StepOutResponse): void {
    if (this.busy(res)) return;
    this.sendResponse(res);
    this.go(this.engine!.stepOut());
  }

  protected pauseRequest(res: DebugProtocol.PauseResponse): void {
    this.engine?.pause();
    this.sendResponse(res);
  }

  protected async restartRequest(res: DebugProtocol.RestartResponse): Promise<void> {
    if (this.engine?.running) { this.engine.pause(); await new Promise((r) => setTimeout(r, 20)); }
    const err = await this.build(); // re-assemble so edits take effect
    if (err) return this.sendErrorResponse(res, 1, err);
    this.engine!.reset();
    this.sendResponse(res);
    this.stopped({ reason: 'entry' });
  }

  protected terminateRequest(res: DebugProtocol.TerminateResponse): void {
    this.engine?.pause();
    this.custom({ event: 'avr/ui', body: { type: 'ended' } });
    this.sendResponse(res);
    this.sendEvent(new TerminatedEvent());
  }

  protected disconnectRequest(res: DebugProtocol.DisconnectResponse): void {
    this.engine?.pause();
    this.custom({ event: 'avr/ui', body: { type: 'ended' } });
    this.sendResponse(res);
  }

  // ---- breakpoints --------------------------------------------------------------------

  protected setBreakPointsRequest(res: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
    const file = path.resolve(args.source.path ?? '');
    const bps = args.breakpoints ?? [];
    this.srcBreakpoints.set(file, bps);
    res.body = { breakpoints: this.resolveBreakpoints(file, bps) };
    this.sendResponse(res);
  }

  /** Each breakpoint moves to the next line with code (blank/comment/label-only lines have none). */
  private resolveBreakpoints(file: string, bps: DebugProtocol.SourceBreakpoint[]): DebugProtocol.Breakpoint[] {
    const e = this.engine;
    if (!e) return bps.map((b) => ({ verified: false, line: b.line }));
    // Drop old addresses for this file, then add the new ones.
    for (const a of [...e.breakpoints]) if (e.map.addrToLoc(a)?.file === file) e.breakpoints.delete(a);
    const lines = e.map.codeLines(file).sort((a, b) => a - b);
    return bps.map((b) => {
      const line = lines.find((l) => l >= b.line);
      if (line === undefined) return { verified: false, line: b.line, message: 'No code at or after this line' };
      e.breakpoints.add(Math.min(...e.map.locToAddrs(file, line)));
      return { verified: true, line, source: new Source(path.basename(file), file) };
    });
  }

  protected setFunctionBreakPointsRequest(res: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {
    const e = this.engine;
    e?.functionBreakpoints.clear();
    res.body = { breakpoints: args.breakpoints.map((b) => {
      const l = e && [...e.syms.labels].find(([n]) => n.toLowerCase() === b.name.trim().toLowerCase());
      if (!e || !l || l[1].seg !== 'cseg') return { verified: false, message: `No code label "${b.name}"` };
      e.functionBreakpoints.add(l[1].addr);
      const loc = e.map.addrToLoc(l[1].addr);
      return { verified: true, line: loc?.line, source: loc && new Source(path.basename(loc.file), loc.file) };
    }) };
    this.sendResponse(res);
  }

  // ---- state inspection ---------------------------------------------------------------

  protected threadsRequest(res: DebugProtocol.ThreadsResponse): void {
    res.body = { threads: [new Thread(THREAD, 'ATmega2560')] };
    this.sendResponse(res);
  }

  protected stackTraceRequest(res: DebugProtocol.StackTraceResponse): void {
    const e = this.engine;
    if (!e) { res.body = { stackFrames: [], totalFrames: 0 }; return this.sendResponse(res); }
    const frame = (id: number, addr: number, name: string) => {
      const loc = e.loc(addr);
      const f = new StackFrame(id, name, loc && new Source(path.basename(loc.file), loc.file), loc?.line ?? 0, 1);
      (f as DebugProtocol.StackFrame).instructionPointerReference = hex(addr, 5);
      return f;
    };
    const fs = e.frames;
    const out = [frame(0, e.sim.pc, `${e.labelFor(e.sim.pc)}`)];
    for (let i = fs.length - 1; i >= 0; i--) {
      const f = fs[i];
      out.push(frame(fs.length - i, f.site, f.irq ? `${e.labelFor(f.site)} (interrupted)` : e.labelFor(f.site)));
    }
    res.body = { stackFrames: out, totalFrames: out.length };
    this.sendResponse(res);
  }

  protected scopesRequest(res: DebugProtocol.ScopesResponse): void {
    res.body = { scopes: [
      new Scope('Registers', Ref.Registers, false),
      new Scope('Status & Pointers', Ref.Status, false),
      new Scope('Time', Ref.Time, false),
    ] };
    this.sendResponse(res);
  }

  protected variablesRequest(res: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
    const e = this.engine;
    const v = (name: string, value: string, extra: Partial<DebugProtocol.Variable> = {}): DebugProtocol.Variable =>
      ({ name, value, variablesReference: 0, ...extra });
    let vars: DebugProtocol.Variable[] = [];
    if (e) {
      const sim = e.sim;
      if (args.variablesReference === Ref.Registers) {
        const defs = e.syms.defsAt(e.loc());
        vars = Array.from({ length: 32 }, (_, n) => {
          const names = [...defs].filter(([, r]) => r === n).map(([a]) => a);
          return v(names.length ? `r${n} (${names.join(', ')})` : `r${n}`, fmtByte(sim.readReg(n)), { evaluateName: `r${n}` });
        });
      } else if (args.variablesReference === Ref.Status) {
        const word = (lo: number) => sim.readReg(lo) | (sim.readReg(lo + 1) << 8);
        vars = [
          v('PC', `${hex(sim.pc, 5)} (${e.labelFor(sim.pc)})`, { evaluateName: 'PC' }),
          v('SP', fmtWord(sim.sp), { evaluateName: 'SP', memoryReference: `data@${sim.sp}` }),
          ...(['X', 'Y', 'Z'] as const).map((p, i) => v(p, fmtWord(word(26 + 2 * i)), { evaluateName: p, memoryReference: `data@${word(26 + 2 * i)}` })),
          v('SREG', `${fmtByte(sim.sreg)} ${FLAGS.map((f, i) => (sim.sreg >> i) & 1 ? f : '-').reverse().join('')}`, { evaluateName: 'SREG' }),
          ...[...FLAGS].reverse().map((f) => v(f, String(!!(sim.sreg & (1 << FLAGS.indexOf(f)))), { type: 'boolean' })),
        ];
      } else if (args.variablesReference === Ref.Time) {
        const us = (c: number) => (c / (sim.clockHz / 1e6));
        const fmtT = (c: number) => { const t = us(c); return t >= 1000 ? `${(t / 1000).toFixed(3)} ms` : `${t.toFixed(3)} µs`; };
        vars = [
          v('Cycles', String(sim.cycles)),
          v('Elapsed (16 MHz)', fmtT(sim.cycles)),
          v('Stopwatch', fmtT(sim.cycles - e.stopwatchStart)), // set to anything to reset
          v('Mode', e.realtime ? 'real-time' : 'max speed'),
        ];
      }
    }
    res.body = { variables: vars };
    this.sendResponse(res);
  }

  protected setVariableRequest(res: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
    const e = this.engine;
    if (!e || e.running) return this.sendErrorResponse(res, 3, 'Target is running');
    const sim = e.sim;
    const name = args.name.replace(/ \(.*\)$/, '');
    const val = args.value.trim().toLowerCase();
    const num = parseNumber(val);
    try {
      if (name === 'Stopwatch') {
        e.stopwatchStart = sim.cycles;
        res.body = { value: '0.000 µs' };
      } else if (FLAGS.includes(name)) {
        const on = val === 'true' || val === '1';
        if (!on && val !== 'false' && val !== '0') throw new Error('Use true/false or 1/0');
        const bit = 1 << FLAGS.indexOf(name);
        sim.sreg = on ? sim.sreg | bit : sim.sreg & ~bit;
        res.body = { value: String(on) };
      } else {
        if (num === undefined) throw new Error(`Not a number: ${args.value}`);
        let m: RegExpExecArray | null;
        if ((m = /^r(\d+)$/.exec(name))) { sim.writeReg(+m[1], num); res.body = { value: fmtByte(sim.readReg(+m[1])) }; }
        else if (name === 'PC') { sim.pc = num; res.body = { value: hex(num, 5) }; }
        else if (name === 'SP') { sim.sp = num; res.body = { value: fmtWord(num) }; }
        else if (name === 'SREG') { sim.sreg = num; res.body = { value: fmtByte(num & 0xff) }; }
        else if (['X', 'Y', 'Z'].includes(name)) {
          const lo = 26 + 2 * ['X', 'Y', 'Z'].indexOf(name);
          sim.writeReg(lo, num & 0xff); sim.writeReg(lo + 1, (num >> 8) & 0xff);
          res.body = { value: fmtWord(num & 0xffff) };
        } else throw new Error(`${name} can't be set`);
      }
    } catch (err) {
      return this.sendErrorResponse(res, 4, (err as Error).message);
    }
    this.sendResponse(res);
    this.pushUi();
  }

  protected evaluateRequest(res: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
    const e = this.engine;
    if (!e) return this.sendErrorResponse(res, 2, 'Not launched');
    try {
      const r = evaluate(args.expression, e.sim, e.syms, e.loc());
      res.body = { result: r.text, variablesReference: 0, memoryReference: r.memoryReference };
      this.sendResponse(res);
    } catch (err) {
      // Hovers over non-symbols should fail quietly.
      this.sendErrorResponse(res, 5, args.context === 'hover' ? '' : (err as Error).message);
    }
  }

  // ---- memory: "data@<addr>", "flash@<byteAddr>", "eeprom@<addr>" ----------------------

  private memSpace(ref: string, offset = 0): { space: string; addr: number; size: number } {
    const m = /^(data|flash|eeprom)@(\d+)$/.exec(ref);
    if (!m) throw new Error(`Bad memory reference ${ref}`);
    const size = m[1] === 'data' ? 0x2200 : m[1] === 'flash' ? 0x40000 : 0x1000;
    return { space: m[1], addr: +m[2] + offset, size };
  }

  protected readMemoryRequest(res: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): void {
    const e = this.engine;
    if (!e) return this.sendErrorResponse(res, 2, 'Not launched');
    try {
      const { space, addr, size } = this.memSpace(args.memoryReference, args.offset ?? 0);
      const start = Math.max(0, addr), end = Math.min(size, addr + args.count);
      let bytes: Uint8Array = new Uint8Array(0);
      if (end > start) {
        if (space === 'flash') bytes = e.sim.readFlash(start, end - start);
        else if (space === 'eeprom') bytes = e.sim.readEeprom(start, end - start);
        else bytes = Uint8Array.from({ length: end - start }, (_, i) => e.sim.readData(start + i));
      }
      res.body = { address: hex(addr, 4), data: Buffer.from(bytes).toString('base64'),
        unreadableBytes: args.count - bytes.length };
      this.sendResponse(res);
    } catch (err) { this.sendErrorResponse(res, 6, (err as Error).message); }
  }

  protected writeMemoryRequest(res: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments): void {
    const e = this.engine;
    if (!e || e.running) return this.sendErrorResponse(res, 3, 'Target is running');
    try {
      const { space, addr, size } = this.memSpace(args.memoryReference, args.offset ?? 0);
      if (space !== 'data') throw new Error(`${space} is read-only in the debugger`);
      const data = Buffer.from(args.data, 'base64');
      const n = Math.max(0, Math.min(data.length, size - addr));
      for (let i = 0; i < n; i++) e.sim.writeData(addr + i, data[i]);
      res.body = { bytesWritten: n };
      this.sendResponse(res);
      this.sendEvent(new Event('memory', { memoryReference: args.memoryReference, offset: args.offset ?? 0, count: n }));
      this.pushUi();
    } catch (err) { this.sendErrorResponse(res, 6, (err as Error).message); }
  }

  // ---- custom requests from the extension / webview ------------------------------------

  protected customRequest(command: string, res: DebugProtocol.Response, args: any): void {
    const e = this.engine;
    switch (command) {
      case 'avr/ui': this.uiMessage(args as FromWebview); break;
      case 'avr/setRealtime':
        if (e) e.realtime = !!args?.realtime;
        res.body = { realtime: e?.realtime };
        break;
      case 'avr/resetStopwatch': if (e) e.stopwatchStart = e.sim.cycles; break;
      default: return super.customRequest(command, res, args);
    }
    this.sendResponse(res);
  }

  private uiMessage(msg: FromWebview): void {
    const e = this.engine;
    if (!e) return;
    if (msg.type === 'togglePin') {
      const s = e.sim.pins.state(msg.pin);
      e.sim.pins.drive(msg.pin, s.level === 1 ? 0 : 1);
    } else if (msg.type === 'releasePin') {
      e.sim.pins.drive(msg.pin, 'z');
    } else if (msg.type === 'writeIo') {
      e.sim.writeData(msg.addr, msg.value);
    } else if (msg.type === 'board') {
      this.board?.get(msg.id)?.input(msg.input);
    }
    this.pushUi();
  }

  private pushUi(): void {
    const e = this.engine;
    if (!e) return;
    this.custom({ event: 'avr/ui', body: {
      type: 'state', running: e.running, cycles: e.sim.cycles,
      io: ioGroups(e.syms, (a) => e.sim.readData(a)),
      pins: Object.fromEntries(e.sim.pins.pins.map((p) => [p, e.sim.pins.state(p).external])),
      board: this.board?.views() ?? [],
    } });
  }

  private custom(ev: AvrEvent): void {
    this.sendEvent(new Event(ev.event, ev.body));
  }
}
