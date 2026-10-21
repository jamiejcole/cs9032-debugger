// LED bar and push buttons (docs/BOARD.md).
import type { PinBus, PinName } from '../sim/types';
import type { BoardConfig, BoardPeripheral, PeripheralInput, PeripheralView } from './types';

/** LEDs are lit when their pin is an output driven high. Index 0 is the bottom LED. */
export class LedBar implements BoardPeripheral {
  readonly id = 'ledBar';
  private bus?: PinBus;
  private pins: PinName[] = [];

  attach(bus: PinBus, config: BoardConfig): void {
    this.bus = bus;
    this.pins = config.ledBar ?? [];
  }
  detach(): void { this.bus = undefined; }
  view(): PeripheralView {
    return { kind: 'ledBar', id: this.id, leds: this.pins.map((p) => {
      const s = this.bus?.state(p);
      return !!s && s.output && s.level === 1;
    }) };
  }
  input(): void {}
}

/**
 * Active-low push buttons: pressed pulls the pin to 0, released leaves it floating (the
 * program's pull-up makes it read 1). Latch keeps a button pressed until clicked again,
 * because you can't hold the mouse down while stepping.
 */
export class Buttons implements BoardPeripheral {
  readonly id = 'buttons';
  private bus?: PinBus;
  private map: [string, PinName][] = [];
  private held = new Set<string>();
  private latched = new Set<string>();

  attach(bus: PinBus, config: BoardConfig): void {
    this.bus = bus;
    this.map = Object.entries(config.buttons ?? {});
    for (const [name] of this.map) this.apply(name);
  }
  detach(): void {
    for (const [, pin] of this.map) this.bus?.drive(pin, 'z');
    this.bus = undefined;
  }
  view(): PeripheralView {
    return { kind: 'buttons', id: this.id, buttons: this.map.map(([name]) => ({
      name, pressed: this.isDown(name), latched: this.latched.has(name),
    })) };
  }
  input(msg: PeripheralInput): void {
    if (msg.kind !== 'button' || !this.map.some(([n]) => n === msg.name)) return;
    if (msg.action === 'press') this.held.add(msg.name);
    else if (msg.action === 'release') this.held.delete(msg.name);
    else if (this.latched.has(msg.name)) this.latched.delete(msg.name);
    else this.latched.add(msg.name);
    this.apply(msg.name);
  }
  private isDown(name: string) { return this.held.has(name) || this.latched.has(name); }
  private apply(name: string) {
    const pin = this.map.find(([n]) => n === name)?.[1];
    if (pin) this.bus?.drive(pin, this.isDown(name) ? 0 : 'z');
  }
}
