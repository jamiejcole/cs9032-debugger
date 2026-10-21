// Simulator built on the avr8js CPU and instruction decoder (docs/DECISIONS.md D1).
// We own the step loop so we can fix what avr8js gets wrong for the 2560:
//   - interrupt entry is 5 cycles with a 22-bit PC (datasheet §7.8.1), avr8js charges 2
//   - one instruction always runs after SEI / RETI before an interrupt (datasheet §7.8, §7.4.1)
//   - unknown opcodes and SPM stop with "not implemented" instead of acting as NOP
//   - BREAK stops the run, SLEEP actually sleeps until an interrupt
import { CPU, avrInstruction, avrInterrupt, PinState as AvrPinState, type AVRIOPort } from 'avr8js';
import { decode } from './decode';
import { loadIhex } from './ihex';
import { CLOCK_HZ, EEPROM_BYTES, FLASH_BYTES, PORT_LETTERS, SRAM_END, createPeripherals, type PortLetter } from './device/m2560';
import type { DriveLevel, PinBus, PinName, PinState, Simulator, StepResult, StopReason } from './types';

const SREG = 0x5f, SMCR = 0x53;
const OP_SEI = 0x9478, OP_RETI = 0x9518, OP_BREAK = 0x9598, OP_SLEEP = 0x9588;

// avr8js keeps these private; we need them for the step loop and the debugger.
interface CpuInternals {
  nextClockEvent: { cycles: number; callback: () => void; next: unknown } | null;
  clockEventPool: unknown[];
  pendingInterrupts: ({ address: number; constant?: boolean } | null)[];
}

export class AvrSim implements Simulator {
  readonly clockHz = CLOCK_HZ;
  readonly pins: AvrPinBus;
  onBreak?: (addr: number) => void;

  private flash = new Uint16Array(FLASH_BYTES / 2);
  private eepromInit = new Uint8Array(EEPROM_BYTES).fill(0xff);
  private cpu!: CPU;
  private periph!: ReturnType<typeof createPeripherals>;
  private sleeping = false;

  constructor() {
    this.pins = new AvrPinBus();
    this.reset();
  }

  load(hex: string, eep?: string): void {
    const bytes = new Uint8Array(FLASH_BYTES).fill(0xff);
    loadIhex(hex, bytes);
    this.flash = new Uint16Array(bytes.buffer);
    this.eepromInit = new Uint8Array(EEPROM_BYTES).fill(0xff);
    if (eep) loadIhex(eep, this.eepromInit);
    this.periph = undefined!; // force fresh EEPROM contents
    this.reset();
  }

  /** Power-on style reset. EEPROM survives a reset, like on the chip. */
  reset(): void {
    const eeprom = this.periph ? this.periph.eepromBackend.memory : this.eepromInit.slice();
    this.cpu = new CPU(this.flash, SRAM_END + 1 - 0x100);
    this.periph = createPeripherals(this.cpu);
    this.periph.eepromBackend.memory.set(eeprom);
    this.pins.bind(this.periph.ports, this.cpu);
    this.sleeping = false;
  }

  step(): StepResult {
    const cpu = this.cpu;
    const startCycles = cpu.cycles;
    const pc = cpu.pc;

    if (this.sleeping) {
      // Idle until the next clock event; pin changes queue interrupts directly.
      const next = (cpu as unknown as CpuInternals).nextClockEvent;
      cpu.cycles = next ? Math.max(cpu.cycles + 1, next.cycles) : cpu.cycles + 1;
      this.runClockEvents();
      const irq = this.takeInterrupt();
      if (irq !== undefined) {
        this.sleeping = false;
        cpu.cycles += 4; // wake-up from idle: 4 cycles before the vector (datasheet §7.8.1)
      }
      return { pc, cycles: cpu.cycles - startCycles, interrupt: irq };
    }

    const opcode = this.flash[pc];
    const info = decode(opcode);
    if (!info || info.name === 'SPM') {
      const what = info ? 'SPM' : `opcode 0x${opcode.toString(16).padStart(4, '0')}`;
      return { pc, cycles: 0, error: `not implemented: ${what} at word 0x${pc.toString(16)}` };
    }

    avrInstruction(cpu);
    this.runClockEvents();

    const res: StepResult = { pc, cycles: 0 };
    if (opcode === OP_BREAK) {
      res.break = true;
      this.onBreak?.(pc);
    } else if (opcode === OP_SLEEP && cpu.data[SMCR] & 1) {
      this.sleeping = true;
    }
    // The instruction after SEI/RETI always executes before an interrupt is served.
    if (opcode !== OP_SEI && opcode !== OP_RETI) {
      const irq = this.takeInterrupt();
      if (irq !== undefined) {
        res.interrupt = irq;
        this.sleeping = false;
      }
    }
    res.cycles = cpu.cycles - startCycles;
    return res;
  }

  runUntil(predicate: (sim: Simulator) => boolean, maxCycles: number): StopReason {
    const end = this.cpu.cycles + maxCycles;
    while (this.cpu.cycles < end) {
      if (predicate(this)) return { kind: 'predicate' };
      const r = this.step();
      if (r.error) return { kind: 'error', message: r.error };
      if (r.break) return { kind: 'break', addr: r.pc };
    }
    return { kind: 'maxCycles' };
  }

  private runClockEvents(): void {
    const c = this.cpu as unknown as CpuInternals;
    for (let ev = c.nextClockEvent; ev && ev.cycles <= this.cpu.cycles; ev = c.nextClockEvent) {
      c.nextClockEvent = ev.next as CpuInternals['nextClockEvent'];
      ev.callback();
      if (c.clockEventPool.length < 10) c.clockEventPool.push(ev);
    }
  }

  /** Same as avr8js CPU.tick()'s interrupt half, with the 2560's 5-cycle entry. */
  private takeInterrupt(): number | undefined {
    const cpu = this.cpu;
    const next = cpu.nextInterrupt;
    if (!cpu.interruptsEnabled || next < 0) return undefined;
    const irq = (cpu as unknown as CpuInternals).pendingInterrupts[next]!;
    avrInterrupt(cpu, irq.address); // pushes 3 bytes, clears I, +2 cycles
    cpu.cycles += 3;
    if (!irq.constant) cpu.clearInterrupt(irq as any);
    return irq.address;
  }

  readReg(n: number): number { return this.cpu.data[n]; }
  writeReg(n: number, v: number): void { this.cpu.data[n] = v & 0xff; }
  readData(addr: number): number { return this.cpu.readData(addr); }
  writeData(addr: number, v: number): void {
    if (addr < 0x20) this.cpu.data[addr] = v & 0xff;
    else this.cpu.writeData(addr, v & 0xff);
  }
  opcodeAt(wordAddr: number): number { return this.flash[wordAddr]; }
  readFlash(byteAddr: number, len: number): Uint8Array {
    return new Uint8Array(this.flash.buffer).slice(byteAddr, byteAddr + len);
  }
  readEeprom(addr: number, len: number): Uint8Array {
    return this.periph.eepromBackend.memory.slice(addr, addr + len);
  }

  get pc() { return this.cpu.pc; }
  set pc(v: number) { this.cpu.pc = v; this.sleeping = false; }
  get sp() { return this.cpu.SP; }
  set sp(v: number) { this.cpu.SP = v; }
  get sreg() { return this.cpu.data[SREG]; }
  set sreg(v: number) { this.cpu.data[SREG] = v & 0xff; }
  get cycles() { return this.cpu.cycles; }
  get isSleeping() { return this.sleeping; }

  pendingInterrupts(): number[] {
    const p = (this.cpu as unknown as CpuInternals).pendingInterrupts;
    const out: number[] = [];
    p.forEach((irq, addr) => irq && out.push(addr));
    return out;
  }
}

class AvrPinBus implements PinBus {
  readonly pins: PinName[] = PORT_LETTERS.flatMap((l) =>
    Array.from({ length: l === 'G' ? 6 : 8 }, (_, i) => `P${l}${i}`));
  private ports!: Record<PortLetter, AVRIOPort>;
  private cpu!: CPU;
  private external = new Map<PinName, DriveLevel>();
  private subs = new Map<PinName, Set<(s: PinState) => void>>();
  private last = new Map<PinName, string>();

  bind(ports: Record<PortLetter, AVRIOPort>, cpu: CPU): void {
    this.ports = ports;
    this.cpu = cpu;
    for (const l of PORT_LETTERS) {
      ports[l].addListener(() => this.refresh(l));
      this.refresh(l);
    }
  }

  private parse(pin: PinName): [PortLetter, number] {
    const m = /^P([A-L])([0-7])$/.exec(pin);
    if (!m || !this.pins.includes(pin)) throw new Error(`unknown pin ${pin}`);
    return [m[1] as PortLetter, +m[2]];
  }

  state(pin: PinName): PinState {
    const [l, i] = this.parse(pin);
    const port = this.ports[l];
    const cfg = port.portConfig;
    const bit = 1 << i;
    const output = !!(this.cpu.data[cfg.DDR] & bit);
    const portBit = !!(this.cpu.data[cfg.PORT] & bit);
    const external = this.external.get(pin) ?? 'z';
    const s = port.pinState(i);
    // Datasheet §13.2.1: a driven input wins over the pull-up; undriven input with PORTx=1 reads high.
    const level = s === AvrPinState.High ? 1 : s === AvrPinState.Low ? 0
      : external !== 'z' ? external : s === AvrPinState.InputPullUp ? 1 : 'z';
    return { output, port: portBit, external, level };
  }

  drive(pin: PinName, level: DriveLevel): void {
    const [l] = this.parse(pin);
    if (level === 'z') this.external.delete(pin);
    else this.external.set(pin, level);
    this.refresh(l);
  }

  subscribe(pin: PinName, cb: (s: PinState) => void): () => void {
    this.parse(pin);
    let set = this.subs.get(pin);
    if (!set) this.subs.set(pin, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  /** Push external drive / pull-ups into avr8js's PINx, then notify subscribers. */
  private refresh(l: PortLetter): void {
    const port = this.ports[l];
    const portReg = this.cpu.data[port.portConfig.PORT];
    for (let i = 0; i < 8; i++) {
      const ext = this.external.get(`P${l}${i}`);
      port.setPin(i, ext !== undefined ? ext === 1 : !!(portReg & (1 << i)));
    }
    for (let i = 0; i < 8; i++) {
      const pin = `P${l}${i}`;
      const set = this.subs.get(pin);
      if (!set?.size) continue;
      const s = this.state(pin);
      const key = `${s.output}${s.port}${s.external}${s.level}`;
      if (this.last.get(pin) === key) continue;
      this.last.set(pin, key);
      for (const cb of set) cb(s);
    }
  }
}
