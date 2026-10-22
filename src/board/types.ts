// Contract: see docs/CONTRACTS.md. Changes go through docs/proposals/.
import type { PinBus, PinName } from '../sim/types';

/** Wiring from .vscode/avr-board.json or launch.json `board`. Every field optional. */
export interface BoardConfig {
  ledBar?: PinName[];
  /** Board button label -> MCU pin, e.g. { "PB0": "PD0" }. */
  buttons?: Record<string, PinName>;
  lcd?: { data: string; rs: PinName; rw: PinName; e: PinName; /** Backlight (PE3). */ bl?: PinName };
  keypad?: { rows: PinName[]; cols: PinName[] };
  motor?: { drive: PinName; sensor: PinName };
  pot?: { adcChannel: number };
}

export interface LcdView {
  kind: 'lcd';
  id: string;
  /** Rows as shown (1 row in 1-line mode). CG RAM characters appear as spaces; see `custom`. */
  lines: string[];
  /** CG RAM characters on screen: 5-bit pixel rows, top to bottom. */
  custom: { row: number; col: number; rows: number[] }[];
  cursor?: { row: number; col: number; underline: boolean; blink: boolean };
  /** Display ON/OFF control (D). Off keeps the contents but shows nothing. */
  on: boolean;
  backlight: boolean;
  busy: boolean;
}

/** Snapshot of one peripheral for the UI. `kind` selects the renderer. */
export type PeripheralView =
  | { kind: 'ledBar'; id: string; leds: boolean[] }
  | { kind: 'buttons'; id: string; buttons: { name: string; pressed: boolean; latched: boolean }[] }
  | LcdView
  | { kind: 'keypad'; id: string; keys: string[][]; pressed: string | null }
  | { kind: 'stub'; id: string; label: string };

export type PeripheralInput =
  | { kind: 'button'; name: string; action: 'press' | 'release' | 'toggleLatch' }
  | { kind: 'key'; key: string | null };

export interface BoardPeripheral {
  readonly id: string;
  attach(bus: PinBus, config: BoardConfig, clock: { cycles(): number; hz: number }): void;
  detach(): void;
  /** The simulated MCU was reset (power cycle). */
  reset?(): void;
  view(): PeripheralView;
  input(msg: PeripheralInput): void;
}
