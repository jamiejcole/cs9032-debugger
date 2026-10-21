// 2560-specific core behaviour: 3-byte return addresses and cycle counts
// (AVR Instruction Set Manual, per-instruction "Words/Cycles" tables, devices with 22-bit PC).
import { describe, expect, it } from 'vitest';
import { AvrSim } from '../../src/sim/avr';

/** Build a hex from words at word address 0. */
function hex(words: number[]): string {
  const bytes = words.flatMap((w) => [w & 0xff, w >> 8]);
  const lines: string[] = [];
  for (let o = 0; o < bytes.length; o += 16) {
    const chunk = bytes.slice(o, o + 16);
    const rec = [chunk.length, (o >> 8) & 0xff, o & 0xff, 0, ...chunk];
    const sum = (-rec.reduce((a, b) => a + b, 0)) & 0xff;
    lines.push(':' + [...rec, sum].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
  return lines.join('\n') + '\n:00000001FF\n';
}
const sim = (words: number[]) => { const s = new AvrSim(); s.load(hex(words)); return s; };

describe('ATmega2560 core', () => {
  it('starts with SP = RAMEND (0x21FF)', () => expect(sim([0]).sp).toBe(0x21ff));

  it('RCALL pushes 3 bytes, takes 4 cycles; RET pops 3 bytes, takes 5', () => {
    const s = sim([0xd001 /* rcall .+2 */, 0x0000, 0x9508 /* ret */]);
    const r = s.step();
    expect(r.cycles).toBe(4);
    expect(s.pc).toBe(2);
    expect(s.sp).toBe(0x21ff - 3);
    expect([s.readData(0x21ff), s.readData(0x21fe), s.readData(0x21fd)]).toEqual([1, 0, 0]);
    expect(s.step().cycles).toBe(5);
    expect(s.pc).toBe(1);
    expect(s.sp).toBe(0x21ff);
  });

  it('CALL is 5 cycles, ICALL 4, EICALL 4', () => {
    expect(sim([0x940e, 0x0004]).step().cycles).toBe(5);
    expect(sim([0x9509]).step().cycles).toBe(4);
    expect(sim([0x9519]).step().cycles).toBe(4);
  });

  it('EIJMP uses EIND:Z', () => {
    const s = sim([0x9419]);
    s.writeData(0x5c, 1); s.writeReg(30, 0x34); s.writeReg(31, 0x12);
    s.step();
    expect(s.pc).toBe(0x11234);
  });

  it('ELPM uses RAMPZ:Z', () => {
    const s = sim([0x9006 /* elpm r0, Z */]);
    s.writeData(0x5b, 0); s.writeReg(30, 0); s.writeReg(31, 0);
    expect(s.step().cycles).toBe(3);
    expect(s.readReg(0)).toBe(0x06);
  });

  it('interrupt entry pushes 3 bytes and takes 5 cycles; RETI is 5', () => {
    // 0: jmp 0x10 (reset)  2: INT0 vector -> reti  0x10: sei; nop; rjmp .-1
    const w = new Array(0x14).fill(0);
    w[0] = 0x940c; w[1] = 0x0010; w[2] = 0x9518;
    w[0x10] = 0x9478; w[0x11] = 0x0000; w[0x12] = 0xcfff;
    const s = sim(w);
    s.writeData(0x6a - 1, 0x02); // EICRA: INT0 falling edge
    s.writeData(0x3d, 0x01);     // EIMSK: INT0
    s.writeData(0x2a, 0x00);     // DDRD input
    s.writeData(0x2b, 0x01);     // PORTD0 pull-up
    s.step(); // jmp
    s.step(); // sei
    s.pins.drive('PD0', 0);      // falling edge -> INT0 pending
    const after = s.step();      // nop runs (one instruction after SEI), then the interrupt is taken
    expect(after.pc).toBe(0x11);
    expect(after.interrupt).toBe(2);
    expect(after.cycles).toBe(1 + 5);
    expect(s.pc).toBe(2);
    expect(s.sp).toBe(0x21ff - 3);
    expect(s.step().cycles).toBe(5); // reti
    expect(s.pc).toBe(0x12);
  });

  it('stops on unknown opcodes and SPM instead of skipping them', () => {
    expect(sim([0xffff]).step().error).toMatch(/not implemented: opcode 0xffff at word 0x0/);
    expect(sim([0x95e8]).step().error).toMatch(/not implemented: SPM/);
  });

  it('pull-up reads high, external drive wins, PINx write toggles PORTx', () => {
    const s = sim([0]);
    s.writeData(0x2b, 0x02); // PORTD1 pull-up
    expect(s.readData(0x29) & 2).toBe(2);
    expect(s.pins.state('PD1').level).toBe(1);
    s.pins.drive('PD1', 0);
    expect(s.readData(0x29) & 2).toBe(0);
    s.pins.drive('PD1', 'z');
    expect(s.readData(0x29) & 2).toBe(2);
    s.writeData(0x27, 0xff); // DDRC out
    s.writeData(0x26, 0x81); // PINC write toggles PORTC
    expect(s.readData(0x28)).toBe(0x81);
    expect(s.pins.state('PC7')).toMatchObject({ output: true, level: 1 });
    expect(s.pins.state('PL3').level).toBe('z');
  });
});
