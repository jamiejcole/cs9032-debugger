// HD44780-style character LCD (Optrex DMC series), modelled from the user's manual
// (LCD_Manual.pdf, https://cgi.cse.unsw.edu.au/~cs9032/refs/LCD_Manual.pdf). Section numbers below
// refer to that manual. Behaviour the manual calls "abnormal" (writing while BF=1) is modelled as
// the real chip does it: the write is dropped.
import type { PinBus, PinLevel, PinName } from '../sim/types';
import type { BoardConfig, BoardPeripheral, LcdView } from './types';

// ---- timing ------------------------------------------------------------------------------------
/** Table 3.1 gives 15.2 ms for Clear/Home at 250 kHz. That is a typo for 1.52 ms (the HD44780
 *  figure, 1.64 ms at 250 kHz in Optrex's own tables), so we use 1.64 ms. Normal instructions: 40 µs. */
const CLEAR_HOME_US = 1640;
const INSTRUCTION_US = 40;
/** §2.2.1: the internal reset makes the busy flag active 10 ms after Vcc rises, until the reset
 *  sequence (clear + function set + display off + entry mode) has finished executing. */
const POWER_ON_US = 10_000 + CLEAR_HOME_US + 3 * INSTRUCTION_US;

const DISPLAY_COLS = 16;
const DDRAM_BYTES = 80; // §1.7.4
const CGRAM_BYTES = 64; // §1.7.8
/** CG RAM is plain RAM that the reset sequence never clears (§2.2.1), so it holds junk at power-on.
 *  On the lab board every row of character 4 (code 0x04/0x0C) reads 0b01010: two vertical bars. */
const CGRAM_POWER_ON = 0x0a;

/** Standard (A00) character ROM as unicode, for the codes the manual's Table 5.3 shows. */
const ROM_E0 = ["α", "ä", "β", "ε", "μ", "σ", "ρ", "g", "√", "⁻", "j", "ˣ", "¢", "£", "ñ", "ö",
  "p", "q", "θ", "∞", "Ω", "ü", "Σ", "π", "x", "y", "千", "万", "円", "÷", " ", "█"];
export function romChar(code: number): string {
  if (code >= 0x20 && code <= 0x7d) return code === 0x5c ? '¥' : String.fromCharCode(code);
  if (code === 0x7e) return '→';
  if (code === 0x7f) return '←';
  if (code >= 0xa1 && code <= 0xdf) return String.fromCharCode(0xff61 + code - 0xa1);
  if (code >= 0xe0) return ROM_E0[code - 0xe0];
  return ' ';
}

export class Lcd implements BoardPeripheral {
  readonly id = 'lcd';
  private bus?: PinBus;
  private clock = { cycles: () => 0, hz: 16_000_000 };
  private data: PinName[] = [];
  private rs?: PinName;
  private rw?: PinName;
  private e?: PinName;
  private bl?: PinName;
  private unsubs: (() => void)[] = [];

  // controller state (§1.7)
  private ddram = new Uint8Array(DDRAM_BYTES).fill(0x20);
  private cgram = new Uint8Array(CGRAM_BYTES);
  private ac = 0;
  private inCgram = false;
  private dr = 0;
  private increment = true;
  private shiftOnWrite = false;
  private shift = 0;
  private displayOn = false;
  private cursorOn = false;
  private blinkOn = false;
  private eightBit = true;
  private twoLines = false;
  private busyUntil = 0;

  // bus state
  private eHigh = false;
  private reading = false;
  private driving = false;
  private phase: 0 | 1 = 0; // 4-bit mode: which nibble is next
  private highNibble = 0;
  private readByte = 0;

  attach(bus: PinBus, config: BoardConfig, clock: { cycles(): number; hz: number }): void {
    const c = config.lcd;
    if (!c) return;
    this.bus = bus;
    this.clock = clock;
    const port = /^PORT([A-L])$/i.exec(c.data)?.[1]?.toUpperCase();
    this.data = port ? Array.from({ length: 8 }, (_, i) => `P${port}${i}`) : [];
    ({ rs: this.rs, rw: this.rw, e: this.e, bl: this.bl } = c);
    if (this.e) {
      let last = bus.state(this.e).level;
      this.unsubs.push(bus.subscribe(this.e, (s) => {
        if (s.level === last) return;
        last = s.level;
        this.onE(s.level === 1);
      }));
    }
    this.reset();
  }

  detach(): void {
    this.releaseData();
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.bus = undefined;
  }

  /** Power-on reset (§2.2.1). Call when the simulated MCU is reset. */
  reset(): void {
    this.ddram.fill(0x20);
    this.cgram.fill(CGRAM_POWER_ON);
    this.ac = 0; this.inCgram = false; this.dr = 0; this.shift = 0;
    this.increment = true; this.shiftOnWrite = false;
    this.displayOn = this.cursorOn = this.blinkOn = false;
    this.eightBit = true; this.twoLines = false;
    this.phase = 0; this.eHigh = false; this.reading = false; this.driving = false;
    this.busyUntil = this.now() + this.cycles(POWER_ON_US * 1000);
  }

  // ---- bus ----------------------------------------------------------------------------------
  private now(): number { return this.clock.cycles(); }
  private cycles(ns: number): number { return (ns * this.clock.hz) / 1e9; }
  private busy(): boolean { return this.now() < this.busyUntil; }

  private level(pin?: PinName): number { return pin && this.bus?.state(pin).level === 1 ? 1 : 0; }
  private readPins(): number {
    return this.data.reduce((v, p, i) => v | (this.level(p) << i), 0);
  }

  private onE(high: boolean): void {
    if (high === this.eHigh) return;
    this.eHigh = high;
    if (high) {
      this.reading = this.level(this.rw) === 1;
      if (this.reading) this.startRead();
    } else {
      if (this.driving) this.releaseData();
      if (this.reading) this.endRead();
      else this.endWrite();
    }
  }

  /** §1.7.1 Table 1.4: RS=0,R/W=1 reads BF + AC; RS=1,R/W=1 reads the data register. */
  private startRead(): void {
    const isData = this.level(this.rs) === 1;
    if (this.eightBit || this.phase === 0) {
      this.readByte = isData ? this.dr : ((this.busy() ? 0x80 : 0) | (this.ac & 0x7f));
    }
    const out = this.eightBit ? this.readByte : this.phase === 0 ? this.readByte & 0xf0 : (this.readByte << 4) & 0xf0;
    const pins = this.eightBit ? this.data : this.data.slice(4);
    const mask = this.eightBit ? 0xff : 0xf0;
    this.driving = true;
    this.data.forEach((p, i) => {
      if (!pins.includes(p)) return;
      if (this.bus!.state(p).output) return; // the MCU is driving the bus too; we can't win
      if ((mask >> i) & 1) this.bus!.drive(p, ((out >> i) & 1) as PinLevel);
    });
  }

  private endRead(): void {
    const isData = this.level(this.rs) === 1;
    if (!this.eightBit) {
      this.phase = this.phase === 0 ? 1 : 0;
      if (this.phase === 1) return;
    }
    if (!isData) return;
    if (this.busy()) return;
    this.step(this.increment ? 1 : -1); // display shift is not executed on a read (§3.1.11)
    this.prefetch();
    this.busyUntil = this.now() + this.cycles(INSTRUCTION_US * 1000);
  }

  private endWrite(): void {
    let byte = this.readPins();
    if (!this.eightBit) {
      if (this.phase === 0) { this.highNibble = byte & 0xf0; this.phase = 1; return; }
      byte = this.highNibble | ((byte >> 4) & 0x0f);
      this.phase = 0;
    }
    this.execute(this.level(this.rs) === 1, byte);
  }

  private releaseData(): void {
    this.driving = false;
    for (const p of this.data) this.bus?.drive(p, 'z');
  }

  // ---- controller ---------------------------------------------------------------------------
  /** Index into the 80-byte DD RAM for an address, or -1 where the module has no RAM (§3.1.8). */
  private phys(addr: number): number {
    if (!this.twoLines) return addr <= 0x4f ? addr : -1;
    if (addr <= 0x27) return addr;
    return addr >= 0x40 && addr <= 0x67 ? addr - 0x18 : -1;
  }

  private ramRead(): number {
    if (this.inCgram) return this.cgram[this.ac & 0x3f];
    const i = this.phys(this.ac);
    return i < 0 ? 0 : this.ddram[i];
  }
  /** Address set / cursor shift / read load the data register from RAM (§1.7.1, §3.1.11). */
  private prefetch(): void { this.dr = this.ramRead(); }

  private step(d: 1 | -1): void {
    if (this.inCgram) this.ac = (this.ac + d) & 0x3f;
    else if (!this.twoLines) this.ac = d > 0 ? (this.ac >= 0x4f ? 0 : this.ac + 1) : (this.ac === 0 || this.ac > 0x4f ? 0x4f : this.ac - 1);
    else this.ac = (this.ac + d) & 0x7f;
  }

  private execute(isData: boolean, v: number): void {
    if (this.busy()) return; // the module ignores anything written while BF=1
    let us = INSTRUCTION_US;
    if (isData) this.writeData(v);
    else {
      if ((v & 0xfc) === 0 && (v & 3)) us = CLEAR_HOME_US;
      this.instruction(v);
    }
    this.busyUntil = this.now() + this.cycles(us * 1000);
  }

  private writeData(v: number): void {
    if (this.inCgram) this.cgram[this.ac & 0x3f] = v;
    else { const i = this.phys(this.ac); if (i >= 0) this.ddram[i] = v; }
    this.dr = v;
    const d = this.increment ? 1 : -1;
    this.step(d);
    if (this.shiftOnWrite && !this.inCgram) this.shift += d; // display shifts left when incrementing (§3.1.3)
  }

  private instruction(v: number): void {
    if (v & 0x80) { this.inCgram = false; this.ac = v & 0x7f; this.prefetch(); } // §3.1.8
    else if (v & 0x40) { this.inCgram = true; this.ac = v & 0x3f; this.prefetch(); } // §3.1.7
    else if (v & 0x20) { // §3.1.6
      this.eightBit = !!(v & 0x10);
      this.twoLines = !!(v & 0x08);
      this.phase = 0;
    } else if (v & 0x10) { // §3.1.5
      const right = !!(v & 0x04);
      if (v & 0x08) this.shift += right ? -1 : 1;
      else { this.step(right ? 1 : -1); this.prefetch(); }
    } else if (v & 0x08) { // §3.1.4
      this.displayOn = !!(v & 4); this.cursorOn = !!(v & 2); this.blinkOn = !!(v & 1);
    } else if (v & 0x04) { this.increment = !!(v & 2); this.shiftOnWrite = !!(v & 1); } // §3.1.3
    else if (v & 0x02) { this.ac = 0; this.inCgram = false; this.shift = 0; } // §3.1.2
    else if (v & 0x01) { // §3.1.1: also selects increment mode
      this.ddram.fill(0x20); this.ac = 0; this.inCgram = false; this.shift = 0; this.increment = true;
    }
  }

  // ---- view ---------------------------------------------------------------------------------
  view(): LcdView {
    const mod = (n: number, m: number) => ((n % m) + m) % m;
    const rows = this.twoLines ? [0x00, 0x40] : [0x00];
    const ring = this.twoLines ? 40 : DDRAM_BYTES;
    const lines: string[] = [];
    const custom: LcdView['custom'] = [];
    rows.forEach((base, row) => {
      let text = '';
      for (let col = 0; col < DISPLAY_COLS; col++) {
        const code = this.ddram[this.phys(base + mod(this.shift + col, ring))];
        if ((code & 0xf0) === 0) { // §1.7.8: codes 0-7 (8-15) are CG RAM characters
          const o = (code & 7) * 8;
          custom.push({ row, col, rows: Array.from(this.cgram.subarray(o, o + 8), (b) => b & 0x1f) });
          text += ' ';
        } else text += romChar(code);
      }
      lines.push(text);
    });
    let cursor: LcdView['cursor'];
    if ((this.cursorOn || this.blinkOn) && !this.inCgram && this.phys(this.ac) >= 0) {
      const row = this.twoLines && this.ac >= 0x40 ? 1 : 0;
      const col = mod(this.ac - (row ? 0x40 : 0) - this.shift, ring);
      if (col < DISPLAY_COLS) cursor = { row, col, underline: this.cursorOn, blink: this.blinkOn };
    }
    return {
      kind: 'lcd', id: this.id, lines, custom, cursor, on: this.displayOn,
      backlight: this.bl ? this.bus?.state(this.bl).level === 1 : true,
      busy: this.busy(),
    };
  }

  input(): void {}
}
