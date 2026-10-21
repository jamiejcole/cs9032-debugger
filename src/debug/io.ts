// I/O view model: registers grouped like Microchip Studio's I/O view.
import type { AsmSymbols } from '../toolchain/symbols';
import type { IoGroupView } from '../ui/protocol';

const PORTS = 'ABCDEFGHJKL'.split('');

/** [group name, register names in display order]. Registers the include doesn't define are skipped. */
function layout(): [string, string[]][] {
  const t16 = (n: number) => [`TCCR${n}A`, `TCCR${n}B`, `TCCR${n}C`, `TCNT${n}H`, `TCNT${n}L`,
    `OCR${n}AH`, `OCR${n}AL`, `OCR${n}BH`, `OCR${n}BL`, `OCR${n}CH`, `OCR${n}CL`, `ICR${n}H`, `ICR${n}L`, `TIMSK${n}`, `TIFR${n}`];
  const usart = (n: number) => [`UDR${n}`, `UCSR${n}A`, `UCSR${n}B`, `UCSR${n}C`, `UBRR${n}H`, `UBRR${n}L`];
  return [
    ...PORTS.map((p): [string, string[]] => [`PORT${p}`, [`PIN${p}`, `DDR${p}`, `PORT${p}`]]),
    ['TIMER/COUNTER0', ['TCCR0A', 'TCCR0B', 'TCNT0', 'OCR0A', 'OCR0B', 'TIMSK0', 'TIFR0']],
    ['TIMER/COUNTER1', t16(1)],
    ['TIMER/COUNTER2', ['TCCR2A', 'TCCR2B', 'TCNT2', 'OCR2A', 'OCR2B', 'TIMSK2', 'TIFR2', 'ASSR']],
    ['TIMER/COUNTER3', t16(3)],
    ['TIMER/COUNTER4', t16(4)],
    ['TIMER/COUNTER5', t16(5)],
    ['EXINT', ['EICRA', 'EICRB', 'EIMSK', 'EIFR', 'PCICR', 'PCIFR', 'PCMSK0', 'PCMSK1', 'PCMSK2']],
    ['USART0', usart(0)], ['USART1', usart(1)], ['USART2', usart(2)], ['USART3', usart(3)],
    ['ADC', ['ADMUX', 'ADCSRA', 'ADCSRB', 'ADCH', 'ADCL', 'DIDR0', 'DIDR2']],
    ['EEPROM', ['EEARH', 'EEARL', 'EEDR', 'EECR']],
    ['CPU', ['SREG', 'SPH', 'SPL', 'RAMPZ', 'EIND', 'MCUCR', 'MCUSR', 'SMCR', 'GPIOR0', 'GPIOR1', 'GPIOR2']],
  ];
}

export function ioGroups(syms: AsmSymbols, read: (addr: number) => number): IoGroupView[] {
  const out: IoGroupView[] = [];
  for (const [name, regs] of layout()) {
    const views = regs.filter((r) => syms.io.has(r)).map((r) => {
      const addr = syms.io.get(r)!;
      const bits = syms.ioBits.get(r);
      return { name: r, addr, value: read(addr), bits: bits ? [...bits].reverse() : undefined };
    });
    if (views.length) out.push({ name, regs: views });
  }
  return out;
}
