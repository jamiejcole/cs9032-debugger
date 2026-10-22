import type { PinBus } from '../sim/types';
import { Buttons, LedBar } from './basic';
import { Keypad } from './keypad';
import { Lcd } from './lcd';
import type { BoardConfig, BoardPeripheral } from './types';

/** Lab 2 wiring (docs/BOARD.md). Used for any field the student's config leaves out. */
export const DEFAULT_BOARD: BoardConfig = {
  ledBar: ['PC0', 'PC1', 'PC2', 'PC3', 'PC4', 'PC5', 'PC6', 'PC7', 'PG0', 'PG1'],
  buttons: { PB0: 'PD0', PB1: 'PD1' },
  lcd: { data: 'PORTF', rs: 'PA7', rw: 'PA5', e: 'PA6', bl: 'PE3' },
  keypad: { rows: ['PL7', 'PL6', 'PL5', 'PL4'], cols: ['PL3', 'PL2', 'PL1', 'PL0'] },
};

export class Board {
  readonly peripherals: BoardPeripheral[] = [new LedBar(), new Buttons(), new Lcd(), new Keypad()];

  constructor(bus: PinBus, readonly config: BoardConfig, clock: { cycles(): number; hz: number }) {
    for (const p of this.peripherals) p.attach(bus, config, clock);
  }
  reset() { for (const p of this.peripherals) p.reset?.(); }
  views() { return this.peripherals.map((p) => p.view()); }
  get(id: string) { return this.peripherals.find((p) => p.id === id); }
}
