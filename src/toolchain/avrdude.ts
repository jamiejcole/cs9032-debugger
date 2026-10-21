import { execFile, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

export const DEFAULT_AVRDUDE = process.platform === 'darwin' ? '/opt/homebrew/bin/avrdude' : 'avrdude';

export function listSerialPorts(dev = '/dev'): string[] {
  if (process.platform === 'win32') return listComPorts();
  try {
    return readdirSync(dev).filter((n) => /^cu\.(usbmodem|usbserial)/.test(n)).map((n) => `${dev}/${n}`);
  } catch { return []; }
}

/** COM ports from the registry, e.g. `\Device\USBSER000    REG_SZ    COM3`. */
function listComPorts(): string[] {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], { encoding: 'utf8' });
    return [...out.matchAll(/REG_SZ\s+(COM\d+)/g)].map((m) => m[1]);
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
