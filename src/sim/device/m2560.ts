// ATmega2560 device description for avr8js. Addresses are data-space (I/O + 0x20).
// Source: ATmega640/1280/1281/2560/2561 datasheet (2549Q) §33 "Register Summary",
// §14 "Interrupts" (vector table), §16 "I/O-Ports" (alternate functions).
// Cross-checked by test/sim/m2560.test.ts against /opt/homebrew/share/avra/m2560def.inc.
import {
  AVRIOPort, AVRTimer, AVREEPROM, EEPROMMemoryBackend, eepromConfig,
  portAConfig, portBConfig, portCConfig, portDConfig, portEConfig, portFConfig, portGConfig,
  portHConfig, portJConfig, portKConfig, portLConfig, timer0Config, timer1Config, timer2Config,
  type CPU,
} from 'avr8js';

export const FLASH_BYTES = 256 * 1024;
export const SRAM_END = 0x21ff;
export const EEPROM_BYTES = 4096;
export const CLOCK_HZ = 16_000_000;

const EICRA = 0x69, EICRB = 0x6a, EIMSK = 0x3d, EIFR = 0x3c;
const intN = (n: number) => ({
  EICR: n < 4 ? EICRA : EICRB, EIMSK, EIFR, index: n, iscOffset: (n % 4) * 2, interrupt: 2 + 2 * n,
});
const PCICR = 0x68, PCIFR = 0x3b;
const pcint = (n: number, mask: number, offset: number) => ({
  PCIE: n, PCICR, PCIFR, PCMSK: 0x6b + n, pinChangeInterrupt: 0x12 + 2 * n, mask, offset,
});

const PORTS = {
  A: portAConfig,
  B: { ...portBConfig, pinChange: pcint(0, 0xff, 0) },
  C: { ...portCConfig, pinChange: undefined },
  D: { ...portDConfig, pinChange: undefined, externalInterrupts: [0, 1, 2, 3].map(intN) },
  E: { ...portEConfig, pinChange: pcint(1, 0x01, 0), externalInterrupts: [null, null, null, null, ...[4, 5, 6, 7].map(intN)] },
  F: portFConfig,
  G: portGConfig,
  H: portHConfig,
  J: { ...portJConfig, pinChange: pcint(1, 0x7f, 1) },
  K: { ...portKConfig, pinChange: pcint(2, 0xff, 0) },
  L: portLConfig,
} as const;
export type PortLetter = keyof typeof PORTS;
export const PORT_LETTERS = Object.keys(PORTS) as PortLetter[];

export function createPeripherals(cpu: CPU) {
  const ports = {} as Record<PortLetter, AVRIOPort>;
  for (const l of PORT_LETTERS) ports[l] = new AVRIOPort(cpu, PORTS[l] as any);
  const P = (l: PortLetter) => PORTS[l].PORT;

  // Timer vectors/pins differ from the 328P; register addresses for 0-2 are the same.
  const t16 = (base: number, timsk: number, tifr: number, vec: number, port: PortLetter, pins: number[], tPort: PortLetter, tPin: number) => ({
    ...timer1Config, TCCRA: base, TCCRB: base + 1, TCCRC: base + 2, TCNT: base + 4, ICR: base + 6,
    OCRA: base + 8, OCRB: base + 10, OCRC: base + 12, TIMSK: timsk, TIFR: tifr,
    captureInterrupt: vec, compAInterrupt: vec + 2, compBInterrupt: vec + 4, compCInterrupt: vec + 6, ovfInterrupt: vec + 8,
    compPortA: P(port), compPinA: pins[0], compPortB: P(port), compPinB: pins[1], compPortC: P(port), compPinC: pins[2],
    externalClockPort: P(tPort), externalClockPin: tPin,
  });
  const timers = [
    new AVRTimer(cpu, { ...timer0Config, compAInterrupt: 0x2a, compBInterrupt: 0x2c, ovfInterrupt: 0x2e,
      compPortA: P('B'), compPinA: 7, compPortB: P('G'), compPinB: 5, externalClockPort: P('D'), externalClockPin: 7 }),
    new AVRTimer(cpu, { ...t16(0x80, 0x6f, 0x36, 0x20, 'B', [5, 6, 7], 'D', 6) }),
    new AVRTimer(cpu, { ...timer2Config, compAInterrupt: 0x1a, compBInterrupt: 0x1c, ovfInterrupt: 0x1e,
      compPortA: P('B'), compPinA: 4, compPortB: P('H'), compPinB: 6 }),
    new AVRTimer(cpu, t16(0x90, 0x71, 0x38, 0x3e, 'E', [3, 4, 5], 'E', 6)),
    new AVRTimer(cpu, t16(0xa0, 0x72, 0x39, 0x52, 'H', [3, 4, 5], 'H', 7)),
    new AVRTimer(cpu, t16(0x120, 0x73, 0x3a, 0x5c, 'L', [3, 4, 5], 'L', 2)),
  ];

  const eepromBackend = new EEPROMMemoryBackend(EEPROM_BYTES);
  const eeprom = new AVREEPROM(cpu, eepromBackend, { ...eepromConfig, eepromReadyInterrupt: 0x3c });

  return { ports, timers, eeprom, eepromBackend };
}
