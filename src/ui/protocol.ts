// Contract: see docs/CONTRACTS.md. Changes go through docs/proposals/.
import type { PeripheralInput, PeripheralView } from '../board/types';
import type { DriveLevel } from '../sim/types';

export interface IoRegView {
  name: string;
  addr: number;
  value: number;
  /** Bit names MSB..LSB where known, else undefined. */
  bits?: (string | null)[];
}

export interface IoGroupView {
  name: string; // "PORTC", "TIMER/COUNTER0", "USART0", "EXINT", "ADC"
  regs: IoRegView[];
}

/** debug/ -> webview */
export type ToWebview =
  | {
      type: 'state'; running: boolean; cycles: number; io: IoGroupView[]; board: PeripheralView[];
      /** External drive per pin ('z' = not driven), so the I/O view can mark driven PINx bits. */
      pins: Record<string, DriveLevel>;
    }
  | { type: 'ended' };

/** webview -> debug/ */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'togglePin'; pin: string } // click on a PINx bit: drive it to the opposite level
  | { type: 'releasePin'; pin: string } // stop driving it (back to pull-up / floating)
  | { type: 'writeIo'; addr: number; value: number }
  | { type: 'board'; id: string; input: PeripheralInput };
