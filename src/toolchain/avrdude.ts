import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';

export const DEFAULT_AVRDUDE = '/opt/homebrew/bin/avrdude';

export function listSerialPorts(dev = '/dev'): string[] {
  try {
    return readdirSync(dev).filter((n) => /^cu\.(usbmodem|usbserial)/.test(n)).map((n) => `${dev}/${n}`);
  } catch { return []; }
}

export function flashArgs(hexPath: string, port: string): string[] {
  return ['-c', 'wiring', '-p', 'm2560', '-P', port, '-b', '115200', '-D', '-U', `flash:w:${hexPath}:i`];
}

export function flash(hexPath: string, port: string, onOutput: (s: string) => void, avrdude = DEFAULT_AVRDUDE): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(avrdude, flashArgs(hexPath, port), (err) => resolve(!err));
    child.stdout?.on('data', (d) => onOutput(String(d)));
    child.stderr?.on('data', (d) => onOutput(String(d)));
  });
}
