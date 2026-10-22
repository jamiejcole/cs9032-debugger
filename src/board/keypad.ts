// 4x4 matrix keypad (docs/BOARD.md). The program drives a row pin low and reads the column pins:
// a pressed key connects one of each, so that column pin reads 0 while the row pin is low.
//
// The lab board is wired transposed from the face layout: the key at face row i, face column j
// joins the row-bank pin rows[3 - j] to the column-bank pin cols[3 - i]. Verified on the board:
// scanning PL4-PL7 as rows and PL0-PL3 as columns, '1' is at (PL4, PL0), '4' at (PL4, PL1),
// '2' at (PL5, PL0), so a program needs the transposed lookup table.
import type { PinBus, PinName } from '../sim/types';
import type { BoardConfig, BoardPeripheral, PeripheralInput, PeripheralView } from './types';

const KEYS = [
  ['1', '2', '3', 'A'],
  ['4', '5', '6', 'B'],
  ['7', '8', '9', 'C'],
  ['*', '0', '#', 'D'],
];

export class Keypad implements BoardPeripheral {
  readonly id = 'keypad';
  private bus?: PinBus;
  private rows: PinName[] = [];
  private cols: PinName[] = [];
  private unsubs: (() => void)[] = [];
  private pressed: string | null = null;

  attach(bus: PinBus, config: BoardConfig): void {
    if (!config.keypad) return;
    this.bus = bus;
    this.rows = config.keypad.rows;
    this.cols = config.keypad.cols;
    for (const r of this.rows) this.unsubs.push(bus.subscribe(r, () => this.update()));
    this.update();
  }

  detach(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    for (const c of this.cols) this.bus?.drive(c, 'z');
    this.bus = undefined;
  }

  view(): PeripheralView {
    return { kind: 'keypad', id: this.id, keys: KEYS, pressed: this.pressed };
  }

  input(msg: PeripheralInput): void {
    if (msg.kind !== 'key') return;
    this.pressed = msg.key !== null && KEYS.flat().includes(msg.key) ? msg.key : null;
    this.update();
  }

  private update(): void {
    const bus = this.bus;
    if (!bus) return;
    const i = KEYS.findIndex((row) => row.includes(this.pressed ?? ''));
    const j = i < 0 ? -1 : KEYS[i].indexOf(this.pressed!);
    const rowPin = i < 0 ? undefined : this.rows[3 - j];
    const colPin = i < 0 ? undefined : this.cols[3 - i];
    const rowLow = !!rowPin && bus.state(rowPin).output && bus.state(rowPin).level === 0;
    this.cols.forEach((pin) => {
      const want = rowLow && pin === colPin && !bus.state(pin).output ? 0 : 'z';
      if (bus.state(pin).external !== want) bus.drive(pin, want);
    });
  }
}
