// Lab 2 end-to-end, driven by simulated time (AVR_DEBUGGER_PROMPT.md §7).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AvrSim } from '../../../src/sim/avr';

const PORTC = 0x28, PORTG = 0x34;
const MS = 16_000;

function boot() {
  const sim = new AvrSim();
  sim.load(readFileSync('test/fixtures/lab2/task2.hex', 'utf8'));
  const run = (ms: number) => expect(sim.runUntil(() => false, ms * MS).kind).toBe('maxCycles');
  const upper = () => {
    const c = sim.readData(PORTC), g = sim.readData(PORTG);
    return ((c >> 6) & 1) | (((c >> 7) & 1) << 1) | ((g & 1) << 2) | (((g >> 1) & 1) << 3);
  };
  const press = (holdMs = 50) => { sim.pins.drive('PD1', 0); run(holdMs); sim.pins.drive('PD1', 'z'); run(50); };
  /** Sample PC0-5 every ms for `ms`, return the times (ms) the pattern changed. */
  const edges = (ms: number) => {
    const out: number[] = [];
    let last = sim.readData(PORTC) & 0x3f;
    for (let t = 1; t <= ms; t++) {
      run(1);
      const v = sim.readData(PORTC) & 0x3f;
      if (v !== last) { out.push(t); expect([0, 0x3f]).toContain(v); last = v; }
    }
    return out;
  };
  run(5);
  return { sim, run, upper, press, edges };
}

describe('lab2 task2', () => {
  it('counts 11, 14, 15, then flashes for 16 and 37 words', () => {
    const b = boot();
    b.press(); expect(b.upper()).toBe(11);
    b.press(); expect(b.upper()).toBe(14);
    b.press(); expect(b.upper()).toBe(15);

    // 4th text: 16 words -> PC0-PC5 toggle about every 200 ms
    b.press();
    const e = b.edges(1000);
    expect(e.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < e.length; i++) expect(Math.abs(e[i] - e[i - 1] - 200)).toBeLessThan(10);

    // Press 5 stops the 16-word flash; the program then loads text 5 (37 words) and flashes again.
    b.press();
    expect(b.edges(1000).length).toBeGreaterThanOrEqual(4);

    // Press 6 stops it; the program wraps to text 1 and shows 11.
    b.press();
    expect(b.edges(600)).toEqual([]);
    expect(b.sim.readData(PORTC) & 0x3f).toBe(0);
    expect(b.upper()).toBe(11);
  });

  it('delay with waitTime=20 lasts 20 ms ±2% (cycle accuracy)', () => {
    const { sim } = boot();
    const delay = 0x5d; // label `delay` (test/fixtures/lab2/task2.map)
    sim.pc = delay;
    sim.writeReg(20, 20);
    const sp = sim.sp;
    // fake a return address of 0x66 (`end: rjmp end`)
    sim.writeData(sp, 0x66); sim.writeData(sp - 1, 0); sim.writeData(sp - 2, 0); sim.sp = sp - 3;
    const start = sim.cycles;
    sim.runUntil((s) => s.pc === 0x66, 1e7);
    const ms = (sim.cycles - start) / MS;
    expect(Math.abs(ms - 20) / 20).toBeLessThan(0.02);
  });
});
