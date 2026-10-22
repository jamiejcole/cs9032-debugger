// Keypad model: the lab board is wired transposed from the face layout (src/board/keypad.ts).
import { describe, expect, it } from 'vitest';
import { Keypad } from '../../src/board/keypad';
import type { DriveLevel, PinBus, PinLevel, PinName, PinState } from '../../src/sim/types';
import { DEFAULT_BOARD } from '../../src/board';

class FakeBus implements PinBus {
  private st = new Map<PinName, PinState>();
  private subs = new Map<PinName, Set<(s: PinState) => void>>();
  state(p: PinName): PinState {
    return this.st.get(p) ?? { output: false, port: false, external: 'z', level: 'z' };
  }
  private put(p: PinName, s: PinState) { this.st.set(p, s); this.subs.get(p)?.forEach((cb) => cb(s)); }
  out(p: PinName, v: PinLevel) { this.put(p, { output: true, port: !!v, external: 'z', level: v }); }
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

/** What lab3.asm does: PL4-PL7 are row outputs 0-3, PL0-PL3 are column inputs 0-3. */
function scan(key: string): { row: number; col: number } | null {
  const bus = new FakeBus();
  const kp = new Keypad();
  kp.attach(bus, DEFAULT_BOARD, { cycles: () => 0, hz: 16_000_000 });
  kp.input({ kind: 'key', key });
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) bus.out(`PL${4 + k}`, k === r ? 0 : 1);
    for (let c = 0; c < 4; c++) if (bus.state(`PL${c}`).level === 0) return { row: r, col: c };
  }
  return null;
}

describe('Keypad', () => {
  it('reads as the transposed table the lab code uses (index = row * 4 + col)', () => {
    const table = '147*2580369#ABCD';
    for (const k of '0123456789ABCD*#') {
      const hit = scan(k)!;
      expect(table[hit.row * 4 + hit.col], k).toBe(k);
    }
  });

  it('reads nothing when no key is held', () => {
    const bus = new FakeBus();
    const kp = new Keypad();
    kp.attach(bus, DEFAULT_BOARD, { cycles: () => 0, hz: 16_000_000 });
    bus.out('PL4', 0);
    for (let c = 0; c < 4; c++) expect(bus.state(`PL${c}`).level).toBe('z');
  });
});
