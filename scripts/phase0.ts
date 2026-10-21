// Phase 0 throwaway: run task2.hex headless, press PD1, print PORTC/PORTG.
import { readFileSync } from 'node:fs';
import { AvrSim } from '../src/sim/avr';

const sim = new AvrSim();
sim.load(readFileSync('reference/lab2/task/task2.hex', 'utf8'));
const ms = (n: number) => sim.runUntil(() => false, n * 16000);
const show = (tag: string) => console.log(tag.padEnd(10),
  'PORTC', sim.readData(0x28).toString(2).padStart(8, '0'),
  'PORTG', sim.readData(0x34).toString(2).padStart(8, '0'),
  `t=${(sim.cycles / 16e3).toFixed(1)}ms`);

ms(5); show('idle');
for (let press = 1; press <= 3; press++) {
  sim.pins.drive('PD1', 0); ms(50); sim.pins.drive('PD1', 'z'); ms(50);
  show(`press ${press}`);
}
