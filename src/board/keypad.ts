// 4x4 matrix keypad (docs/BOARD.md). The program drives a row low and reads the columns:
// a pressed key connects its row to its column, so the column reads 0 while that row is low.
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
    const r = KEYS.findIndex((row) => row.includes(this.pressed ?? ''));
    const c = r < 0 ? -1 : KEYS[r].indexOf(this.pressed!);
    const rowLow = r >= 0 && bus.state(this.rows[r]).output && bus.state(this.rows[r]).level === 0;
    this.cols.forEach((pin, i) => {
      const want = rowLow && i === c && !bus.state(pin).output ? 0 : 'z';
      if (bus.state(pin).external !== want) bus.drive(pin, want);
    });
  }
}
