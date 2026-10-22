// LCD model against the Optrex DMC manual (LCD_Manual.pdf). A fake pin bus plays the MCU, so
// every bus phase and every microsecond is under the test's control.
import { describe, expect, it } from 'vitest';
import { Lcd } from '../../src/board/lcd';
import type { DriveLevel, PinBus, PinLevel, PinName, PinState } from '../../src/sim/types';

class FakeBus implements PinBus {
  readonly pins: PinName[] = [];
  private st = new Map<PinName, PinState>();
  private subs = new Map<PinName, Set<(s: PinState) => void>>();
  state(p: PinName): PinState {
    return this.st.get(p) ?? { output: false, port: false, external: 'z', level: 'z' };
  }
  private put(p: PinName, s: PinState) {
    this.st.set(p, s);
    this.subs.get(p)?.forEach((cb) => cb(s));
  }
  out(p: PinName, v: PinLevel) { this.put(p, { output: true, port: !!v, external: 'z', level: v }); }
  input(p: PinName) { const e = this.state(p).external; this.put(p, { output: false, port: false, external: e, level: e }); }
  drive(p: PinName, l: DriveLevel) {
    const s = this.state(p);
    this.put(p, { ...s, external: l, level: s.output ? s.level : l });
  }
  subscribe(p: PinName, cb: (s: PinState) => void) {
    let set = this.subs.get(p);
    if (!set) this.subs.set(p, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }
}

const HZ = 16_000_000;
const DATA = Array.from({ length: 8 }, (_, i) => `PF${i}`);

function rig() {
  const bus = new FakeBus();
  let cycles = 0;
  const lcd = new Lcd();
  lcd.attach(bus, { lcd: { data: 'PORTF', rs: 'PA7', rw: 'PA5', e: 'PA6', bl: 'PE3' } }, { cycles: () => cycles, hz: HZ });
  const wait = (us: number) => { cycles += us * (HZ / 1e6); };
  for (const p of ['PA7', 'PA5', 'PA6']) bus.out(p, 0);
  bus.out('PE3', 1);
  DATA.forEach((p) => bus.out(p, 0));
  const setData = (v: number) => DATA.forEach((p, i) => bus.out(p, ((v >> i) & 1) as PinLevel));
  /** A well-timed write cycle (E high 1 µs). */
  const write = (rs: 0 | 1, v: number) => {
    bus.out('PA7', rs); bus.out('PA5', 0); setData(v);
    wait(1); bus.out('PA6', 1); wait(1); bus.out('PA6', 0); wait(1);
  };
  const cmd = (v: number, after = 100) => { write(0, v); wait(after); };
  const put = (text: string) => { for (const ch of text) { write(1, ch.charCodeAt(0)); wait(50); } };
  const read = (rs: 0 | 1): number => {
    DATA.forEach((p) => bus.input(p));
    bus.out('PA7', rs); bus.out('PA5', 1); wait(1);
    bus.out('PA6', 1); wait(1);
    const v = DATA.reduce((a, p, i) => a | ((bus.state(p).level === 1 ? 1 : 0) << i), 0);
    bus.out('PA6', 0); wait(1);
    bus.out('PA5', 0);
    return v;
  };
  /** The init sequence from §2.2.2.1 with its waits. */
  const init = (fn = 0x38) => {
    wait(16_000);
    cmd(0x30, 4_200); cmd(0x30, 110); cmd(0x30, 50);
    cmd(fn, 50); cmd(0x08, 50); cmd(0x01, 2_000); cmd(0x06, 50); cmd(0x0c, 50);
  };
  return { bus, lcd, wait, write, cmd, put, read, init, setData, now: () => cycles };
}

describe('LCD power-on and busy flag', () => {
  it('ignores everything until the internal reset has finished (§2.2.1)', () => {
    const r = rig();
    r.wait(5_000);
    r.cmd(0x0f);
    expect(r.lcd.view().on).toBe(false);
    r.wait(12_000);
    r.cmd(0x0f);
    expect(r.lcd.view().on).toBe(true);
  });

  it('starts as 1-line, display off, increment, no shift', () => {
    const r = rig();
    r.wait(16_000);
    const v = r.lcd.view();
    expect(v.on).toBe(false);
    expect(v.lines).toEqual([' '.repeat(16)]);
  });

  it('drops an instruction sent within 40 µs of the previous one', () => {
    const r = rig();
    r.init();
    r.cmd(0x08, 10); // display off, but only 10 µs of its 40 µs elapsed
    r.cmd(0x0c, 100); // dropped
    expect(r.lcd.view().on).toBe(false);
    r.cmd(0x0c, 100); // retried after a proper wait
    expect(r.lcd.view().on).toBe(true);
  });

  it('Clear Display needs more than 1 ms: a 1 ms wait loses the next instruction', () => {
    const r = rig();
    r.init();
    r.put('HI');
    r.cmd(0x01, 1_000);
    r.cmd(0x06, 800); // dropped: still clearing
    r.cmd(0x04, 100); // entry mode decrement, now accepted
    r.cmd(0x81);
    r.put('A');
    r.put('B');
    expect(r.lcd.view().lines[0].slice(0, 2)).toBe('BA'); // decrementing: B written left of A
  });

  it('reads BF and the address counter (RS=0, R/W=1; §1.7.2, §3.1.9)', () => {
    const r = rig();
    r.init();
    r.cmd(0x80 | 0x45, 0);
    r.wait(1);
    expect(r.read(0)).toBe(0x80 | 0x45); // busy straight after the instruction
    r.wait(100);
    expect(r.read(0)).toBe(0x45);
    expect(r.lcd.view().busy).toBe(false);
  });
});

describe('LCD display', () => {
  it('writes two lines with the DD RAM layout 00 and 40 (§1.7.6.3)', () => {
    const r = rig();
    r.init();
    r.put('LCD MODULE DMC16');
    r.cmd(0xc0);
    r.put('16 DIGITS, 2 LINES');
    const v = r.lcd.view();
    expect(v.lines).toEqual(['LCD MODULE DMC16', '16 DIGITS, 2 LIN']);
  });

  it('only shows line 1 until Function Set selects 2 lines', () => {
    const r = rig();
    r.init(0x30); // N=0
    r.put('X');
    r.cmd(0xc0); // 0x40 does not exist in 1-line mode
    r.put('Y');
    const v = r.lcd.view();
    expect(v.lines.length).toBe(1);
    expect(v.lines[0][0]).toBe('X');
  });

  it('display off hides but keeps the contents (§3.1.4)', () => {
    const r = rig();
    r.init();
    r.put('KEEP');
    r.cmd(0x08);
    expect(r.lcd.view().on).toBe(false);
    r.cmd(0x0c);
    expect(r.lcd.view()).toMatchObject({ on: true, lines: [expect.stringMatching(/^KEEP/), expect.anything()] });
  });

  it('shows the cursor at the address counter and blink separately (§3.1.4)', () => {
    const r = rig();
    r.init();
    r.put('AB');
    r.cmd(0x0e);
    expect(r.lcd.view().cursor).toEqual({ row: 0, col: 2, underline: true, blink: false });
    r.cmd(0x0d);
    expect(r.lcd.view().cursor).toEqual({ row: 0, col: 2, underline: false, blink: true });
    r.cmd(0x0c);
    expect(r.lcd.view().cursor).toBeUndefined();
    r.cmd(0xc0 | 3);
    r.cmd(0x0f);
    expect(r.lcd.view().cursor).toMatchObject({ row: 1, col: 3 });
  });

  it('does not continue from line 1 into line 2: addresses 28-3F have no RAM (§3.1.8)', () => {
    const r = rig();
    r.init();
    r.cmd(0x80 | 0x26);
    r.put('abcd'); // 26, 27, then 28 and 29 which are lost
    r.cmd(0xc0);
    r.put('z');
    const v = r.lcd.view();
    expect(v.lines[0].slice(14)).toBe('  '); // line 1 only shows 00-0F
    expect(v.lines[1][0]).toBe('z');
    for (let i = 0; i < 38; i++) r.cmd(0x18); // bring 0x26/0x27 into view at the left
    expect(r.lcd.view().lines[0].slice(0, 2)).toBe('ab');
    expect(r.lcd.view().lines[0].slice(2, 4)).toBe('  ');
  });

  it('Clear Display resets the address, the shift and the entry direction (§3.1.1)', () => {
    const r = rig();
    r.init();
    r.cmd(0x04); r.cmd(0x18); r.put('Q');
    r.cmd(0x01, 2_000);
    r.put('R');
    expect(r.lcd.view().lines[0][0]).toBe('R');
  });
});

describe('LCD shifting (§3.1.3, §3.1.5)', () => {
  it('display shift moves both lines and leaves the AC alone', () => {
    const r = rig();
    r.init();
    r.put('0123456789ABCDEF');
    r.cmd(0xc0);
    r.put('abcdefghijklmnop');
    r.cmd(0x18); // shift display left
    let v = r.lcd.view();
    expect(v.lines[0]).toBe('123456789ABCDEF ');
    expect(v.lines[1]).toBe('bcdefghijklmnop ');
    expect(r.read(0)).toBe(0x50); // AC kept counting from the writes: 0x40 + 16
    r.cmd(0x1c); r.cmd(0x1c); // right x2
    v = r.lcd.view();
    expect(v.lines[0]).toBe(' 0123456789ABCDE'); // net one left
    r.cmd(0x02, 2_000); // home returns the display (§3.1.2)
    expect(r.lcd.view().lines[0]).toBe('0123456789ABCDEF');
  });

  it('cursor shift moves only the AC', () => {
    const r = rig();
    r.init();
    r.put('AB');
    r.cmd(0x10); // cursor left
    expect(r.read(0) & 0x7f).toBe(1);
    r.cmd(0x14); r.cmd(0x14);
    expect(r.read(0) & 0x7f).toBe(3);
  });

  it('entry mode S=1 shifts the display on each write so the cursor stays put', () => {
    const r = rig();
    r.init();
    r.cmd(0x07); // I/D=1, S=1
    r.cmd(0x0e);
    r.put('AB');
    const v = r.lcd.view();
    expect(v.cursor).toMatchObject({ col: 0 });
    expect(v.lines[0]).toBe(' '.repeat(16)); // AB scrolled out of the window to the left
  });
});

describe('LCD reads (§3.1.11)', () => {
  it('Set DD RAM address loads the data register; each read then advances', () => {
    const r = rig();
    r.init();
    r.put('XYZ');
    r.cmd(0x80);
    expect(r.read(1)).toBe('X'.charCodeAt(0));
    r.wait(50);
    expect(r.read(1)).toBe('Y'.charCodeAt(0));
    r.wait(100);
    expect(r.read(1)).toBe('Z'.charCodeAt(0));
  });

  it('a write leaves the written byte in the data register, not the next address', () => {
    const r = rig();
    r.init();
    r.put('XY');
    expect(r.read(1)).toBe('Y'.charCodeAt(0)); // stale: not the (blank) byte at AC
  });
});

describe('LCD CG RAM (§1.7.8)', () => {
  it('is not cleared at power-on: code 0x0C shows the two-bar junk character', () => {
    const r = rig();
    r.init();
    r.write(1, 0x0c); // what lab3.asm sends before the first key
    r.wait(50);
    r.put('6');
    const v = r.lcd.view();
    expect(v.custom).toEqual([{ row: 0, col: 0, rows: Array(8).fill(0x0a) }]);
    expect(v.lines[0].slice(0, 2)).toBe(' 6');
  });

  it('stores 8 rows per character and shows codes 0-7 (and 8-15) as that pattern', () => {
    const r = rig();
    r.init();
    r.cmd(0x40 | (2 << 3)); // character 2, row 0
    [0x1f, 0x11, 0x15, 0x15, 0x15, 0x11, 0x1f, 0x00].forEach((b) => { r.write(1, b); r.wait(50); });
    r.cmd(0x80);
    r.write(1, 0x02); r.wait(50);
    r.write(1, 0x0a); r.wait(50); // bit 3 is ignored (§1.7.8 note 4)
    const v = r.lcd.view();
    expect(v.custom).toHaveLength(2);
    expect(v.custom[0]).toEqual({ row: 0, col: 0, rows: [0x1f, 0x11, 0x15, 0x15, 0x15, 0x11, 0x1f, 0x00] });
    expect(v.custom[1].rows).toEqual(v.custom[0].rows);
  });

  it('hides the DD RAM cursor while the AC points into CG RAM', () => {
    const r = rig();
    r.init();
    r.cmd(0x0e);
    r.cmd(0x40);
    expect(r.lcd.view().cursor).toBeUndefined();
  });
});

describe('LCD 4-bit interface (§2.2.2.2)', () => {
  const nib = (r: ReturnType<typeof rig>, rs: 0 | 1, hi: number) => {
    r.bus.out('PA7', rs); r.bus.out('PA5', 0);
    r.setData(hi << 4);
    r.wait(1); r.bus.out('PA6', 1); r.wait(1); r.bus.out('PA6', 0); r.wait(60);
  };
  const byte = (r: ReturnType<typeof rig>, rs: 0 | 1, v: number) => { nib(r, rs, v >> 4); nib(r, rs, v & 15); };

  it('switches to two transfers per byte on high nibbles', () => {
    const r = rig();
    r.wait(16_000);
    nib(r, 0, 3); r.wait(4_200); nib(r, 0, 3); r.wait(100); nib(r, 0, 3);
    nib(r, 0, 2); // 4-bit from here
    byte(r, 0, 0x28); byte(r, 0, 0x08); byte(r, 0, 0x01); r.wait(2_000); byte(r, 0, 0x06); byte(r, 0, 0x0c);
    byte(r, 1, 0x48); byte(r, 1, 0x69);
    const v = r.lcd.view();
    expect(v.on).toBe(true);
    expect(v.lines[0].slice(0, 2)).toBe('Hi');
  });

  it('reads BF/AC as two nibbles, high first', () => {
    const r = rig();
    r.wait(16_000);
    nib(r, 0, 3); r.wait(4_200); nib(r, 0, 3); r.wait(100); nib(r, 0, 3);
    nib(r, 0, 2);
    byte(r, 0, 0x28); byte(r, 0, 0xc0 | 0x2a);
    r.wait(100);
    const rd = () => {
      for (const p of DATA.slice(4)) r.bus.input(p);
      r.bus.out('PA7', 0); r.bus.out('PA5', 1); r.wait(1);
      r.bus.out('PA6', 1); r.wait(1);
      const v = DATA.slice(4).reduce((a, p, i) => a | ((r.bus.state(p).level === 1 ? 1 : 0) << i), 0);
      r.bus.out('PA6', 0); r.wait(1);
      return v;
    };
    expect((rd() << 4) | rd()).toBe(0x6a & 0x7f);
  });
});

describe('LCD bus', () => {
  it('releases the data lines when E falls', () => {
    const r = rig();
    r.init();
    r.read(0);
    expect(DATA.every((p) => r.bus.state(p).external === 'z')).toBe(true);
  });

  it('is back to the power-on state after reset()', () => {
    const r = rig();
    r.init();
    r.put('HI');
    r.lcd.reset();
    const v = r.lcd.view();
    expect(v.on).toBe(false);
    expect(v.busy).toBe(true);
    expect(v.lines[0].trim()).toBe('');
  });
});
