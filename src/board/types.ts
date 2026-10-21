// Contract: see docs/CONTRACTS.md. Changes go through docs/proposals/.
import type { PinBus, PinName } from '../sim/types';

/** Wiring from .vscode/avr-board.json or launch.json `board`. Every field optional. */
export interface BoardConfig {
  ledBar?: PinName[];
  /** Board button label -> MCU pin, e.g. { "PB0": "PD0" }. */
  buttons?: Record<string, PinName>;
  lcd?: { data: string; rs: PinName; rw: PinName; e: PinName };
  keypad?: { rows: PinName[]; cols: PinName[] };
  motor?: { drive: PinName; sensor: PinName };
  pot?: { adcChannel: number };
}

/** Snapshot of one peripheral for the UI. `kind` selects the renderer. */
export type PeripheralView =
  | { kind: 'ledBar'; id: string; leds: boolean[] }
  | { kind: 'buttons'; id: string; buttons: { name: string; pressed: boolean; latched: boolean }[] }
  | { kind: 'lcd'; id: string; lines: string[]; cursor?: { row: number; col: number }; on: boolean }
  | { kind: 'keypad'; id: string; keys: string[][]; pressed: string | null }
  | { kind: 'stub'; id: string; label: string };

export type PeripheralInput =
  | { kind: 'button'; name: string; action: 'press' | 'release' | 'toggleLatch' }
  | { kind: 'key'; key: string | null };

export interface BoardPeripheral {
  readonly id: string;
  attach(bus: PinBus, config: BoardConfig, clock: { cycles(): number; hz: number }): void;
  detach(): void;
  view(): PeripheralView;
  input(msg: PeripheralInput): void;
}
