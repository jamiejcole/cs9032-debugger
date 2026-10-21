// Contract: see docs/CONTRACTS.md. Changes go through docs/proposals/.
// No `vscode` imports anywhere under src/sim.

/** Pin name like "PC6", "PG0", "PL3". */
export type PinName = string;
export type PinLevel = 0 | 1;
export type DriveLevel = PinLevel | 'z';

export interface PinState {
  /** DDRx bit: true = output. */
  output: boolean;
  /** PORTx bit (output value, or pull-up enable when input). */
  port: boolean;
  /** External drive applied by a board peripheral / UI, 'z' = not driven. */
  external: DriveLevel;
  /** Resolved level as seen on PINx (and by external observers). 'z' = floating input. */
  level: PinLevel | 'z';
}

export interface PinBus {
  /** All pins the device has, e.g. ["PA0", ..., "PL7"]. */
  readonly pins: readonly PinName[];
  state(pin: PinName): PinState;
  /** Apply an external drive. 'z' releases it. A driven input overrides pull-ups. */
  drive(pin: PinName, level: DriveLevel): void;
  /** Called whenever the resolved state of `pin` may have changed. Returns an unsubscribe fn. */
  subscribe(pin: PinName, cb: (s: PinState) => void): () => void;
}

export type StopReason =
  | { kind: 'step' }
  | { kind: 'break'; addr: number } // BREAK opcode or `onBreak` hook
  | { kind: 'predicate' }
  | { kind: 'maxCycles' }
  | { kind: 'sleep' }
  | { kind: 'error'; message: string }; // "not implemented: ..." etc.

export interface StepResult {
  /** Word address of the instruction that was executed (before an interrupt was taken). */
  pc: number;
  /** Cycles consumed (instruction + any interrupt entry). */
  cycles: number;
  /** Word address an interrupt vectored to during this step, if any. */
  interrupt?: number;
  /** The instruction was BREAK. */
  break?: boolean;
  error?: string;
}

export interface Simulator {
  /** Load Intel HEX text into flash (and optionally EEPROM). Calls reset(). */
  load(hex: string, eep?: string): void;
  reset(): void;
  /** Execute exactly one instruction (plus pending interrupt entry). */
  step(): StepResult;
  /**
   * Run until `predicate` returns true (checked before each instruction), an error,
   * a BREAK, or `maxCycles` more cycles elapse.
   */
  runUntil(predicate: (sim: Simulator) => boolean, maxCycles: number): StopReason;

  readReg(n: number): number;
  writeReg(n: number, v: number): void;
  /** Data space: 0x00-0x1F regs, 0x20-0x5F I/O, 0x60-0x1FF ext I/O, 0x200-0x21FF SRAM. */
  readData(addr: number): number;
  /** Writes go through peripheral hooks (same as an ST instruction). */
  writeData(addr: number, v: number): void;
  /** Byte address. */
  readFlash(byteAddr: number, len: number): Uint8Array;
  readEeprom(addr: number, len: number): Uint8Array;

  /** Word address. Settable (DAP "jump"/setVariable). */
  pc: number;
  sp: number;
  sreg: number;
  readonly cycles: number;
  readonly clockHz: number;
  readonly pins: PinBus;

  /** Word addresses of vectors currently pending (flag set and enabled), lowest first. */
  pendingInterrupts(): number[];

  /** Called on a BREAK instruction. */
  onBreak?: (addr: number) => void;
}
