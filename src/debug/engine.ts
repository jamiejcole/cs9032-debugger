// Execution control: shadow call stack, line stepping, breakpoints, real-time throttle.
// No DAP or vscode types here so it can be tested directly.
import { decode } from '../sim/decode';
import type { AvrSim } from '../sim/avr';
import type { StepResult } from '../sim/types';
import type { ObjSourceMap } from '../toolchain/obj';
import type { AsmSymbols } from '../toolchain/symbols';
import type { SourceLoc } from '../toolchain/types';

export interface Frame {
  /** Word address that was called / interrupted to. */
  entry: number;
  /** Address of the call instruction, or the interrupted instruction for an IRQ. */
  site: number;
  /** SP after the return address was pushed. The frame is gone once SP rises above it. */
  sp: number;
  irq: boolean;
}

export type StopReason = 'step' | 'breakpoint' | 'function breakpoint' | 'pause' | 'exception' | 'entry';
export interface Stop { reason: StopReason; text?: string }

const CALLS = new Set(['CALL', 'RCALL', 'ICALL', 'EICALL']);

export class Engine {
  frames: Frame[] = [];
  /** Word addresses. */
  breakpoints = new Set<number>();
  functionBreakpoints = new Set<number>();
  realtime = true;
  running = false;
  stopwatchStart = 0;
  /** Called about 30 times a second while running, for UI refresh. */
  onTick?: () => void;
  private pauseRequested = false;

  constructor(readonly sim: AvrSim, readonly map: ObjSourceMap, readonly syms: AsmSymbols) {}

  reset(): void {
    this.sim.reset();
    this.frames = [];
    this.stopwatchStart = 0;
  }

  pause(): void { this.pauseRequested = true; }

  /** One instruction, keeping the shadow call stack in step. */
  stepInstruction(): StepResult {
    const sim = this.sim;
    const spBefore = sim.sp;
    const info = decode(sim.opcodeAt(sim.pc));
    const r = sim.step();
    if (r.error) return r;
    // Return address on the stack after an interrupt = where execution resumes.
    const sp = sim.sp;
    const resume = r.interrupt === undefined ? sim.pc
      : (sim.readData(sp + 1) << 16) | (sim.readData(sp + 2) << 8) | sim.readData(sp + 3);
    if (info && CALLS.has(info.name)) this.frames.push({ entry: resume, site: r.pc, sp: spBefore - 3, irq: false });
    if (r.interrupt !== undefined) this.frames.push({ entry: r.interrupt, site: resume, sp, irq: true });
    while (this.frames.length && sim.sp > this.frames[this.frames.length - 1].sp) this.frames.pop();
    return r;
  }

  loc(addr = this.sim.pc): SourceLoc | undefined { return this.map.addrToLoc(addr); }

  /** Nearest code label at or below `addr`, as "label" or "label+n". */
  labelFor(addr: number): string {
    let best: [string, number] | undefined;
    for (const [name, l] of this.syms.labels) {
      if (l.seg === 'cseg' && l.addr <= addr && (!best || l.addr > best[1])) best = [name, l.addr];
    }
    if (!best) return `0x${addr.toString(16)}`;
    return addr === best[1] ? best[0] : `${best[0]}+${addr - best[1]}`;
  }

  continue(skipFirstBreakpoint = true): Promise<Stop> {
    return this.run(() => undefined, skipFirstBreakpoint);
  }

  stepInstructionAsync(): Promise<Stop> {
    return this.run(() => 'step', true);
  }

  /** Step to a different source line (entering calls and interrupts). */
  stepIn(): Promise<Stop> {
    const startPc = this.sim.pc, startLoc = this.locKey(startPc), depth = this.frames.length;
    return this.run(() => {
      const pc = this.sim.pc;
      if (!this.map.isCode(pc)) return undefined;
      return this.locKey(pc) !== startLoc || pc === startPc || this.frames.length !== depth ? 'step' : undefined;
    }, true);
  }

  /** Step to a different source line in this frame or a caller (calls and interrupts run through). */
  stepOver(): Promise<Stop> {
    const startPc = this.sim.pc, startLoc = this.locKey(startPc), depth = this.frames.length;
    return this.run(() => {
      const pc = this.sim.pc;
      if (this.frames.length > depth || !this.map.isCode(pc)) return undefined;
      return this.locKey(pc) !== startLoc || pc === startPc || this.frames.length < depth ? 'step' : undefined;
    }, true);
  }

  /** Run until the current frame returns. At top level this is the same as Continue. */
  stepOut(): Promise<Stop> {
    const depth = this.frames.length;
    if (depth === 0) return this.continue();
    return this.run(() => (this.frames.length < depth ? 'step' : undefined), true);
  }

  private locKey(addr: number): string {
    const l = this.map.addrToLoc(addr);
    return l ? `${l.file}:${l.line}` : `@${addr}`;
  }

  /**
   * Run until `done` returns a reason (checked after each instruction), a breakpoint,
   * an error or a pause. Yields to the event loop regularly; throttles to 16 MHz when `realtime`.
   */
  private async run(done: () => StopReason | undefined, skipFirstBreakpoint: boolean): Promise<Stop> {
    const sim = this.sim;
    this.running = true;
    this.pauseRequested = false;
    let first = skipFirstBreakpoint;
    let wall0 = performance.now(), cyc0 = sim.cycles, lastTick = wall0;
    const cyclesPerMs = sim.clockHz / 1000;
    try {
      for (;;) {
        const sliceEnd = sim.cycles + cyclesPerMs * (this.realtime ? 2 : 10);
        while (sim.cycles < sliceEnd) {
          const pc = sim.pc;
          if (!first) {
            if (this.breakpoints.has(pc)) return { reason: 'breakpoint' };
            if (this.functionBreakpoints.has(pc)) return { reason: 'function breakpoint' };
          }
          first = false;
          const r = this.stepInstruction();
          if (r.error) return { reason: 'exception', text: r.error };
          if (r.break) return { reason: 'breakpoint', text: 'BREAK instruction' };
          if (!this.map.isCode(sim.pc) && this.map.addrToLoc(sim.pc)) {
            return { reason: 'exception', text: `PC ran into data (.db/.dw) at ${this.labelFor(sim.pc)} (word 0x${sim.pc.toString(16)})` };
          }
          const reason = done();
          if (reason) return { reason };
        }
        if (this.pauseRequested) return { reason: 'pause' };
        const now = performance.now();
        if (now - lastTick > 33) { lastTick = now; this.onTick?.(); }
        if (this.realtime) {
          const ahead = wall0 + (sim.cycles - cyc0) / cyclesPerMs - now;
          if (ahead > 1) await new Promise((res) => setTimeout(res, ahead));
          else {
            if (ahead < -200) { wall0 = now; cyc0 = sim.cycles; } // can't keep up: don't try to catch a burst
            await new Promise((res) => setImmediate(res));
          }
        } else {
          await new Promise((res) => setImmediate(res));
        }
        if (this.pauseRequested) return { reason: 'pause' };
      }
    } finally {
      this.running = false;
    }
  }
}
