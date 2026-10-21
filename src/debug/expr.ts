// Watch / hover / REPL expressions: r0-r31, .def aliases, X/Y/Z, PC, SP, I/O names,
// .equ constants, labels, numbers, and [addr] / [label] / [X] for a data-space byte.
import type { Simulator } from '../sim/types';
import type { AsmSymbols } from '../toolchain/symbols';
import type { SourceLoc } from '../toolchain/types';

export interface EvalResult { value: number; text: string; memoryReference?: string }

export const hex = (v: number, digits: number) => `0x${v.toString(16).toUpperCase().padStart(digits, '0')}`;
export const fmtByte = (v: number) => `${hex(v, 2)} (${v})`;
export const fmtWord = (v: number) => `${hex(v, 4)} (${v})`;

const PAIRS: Record<string, number> = { X: 26, Y: 28, Z: 30 };

export function parseNumber(s: string): number | undefined {
  const t = s.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(?:0x|\$)([0-9a-f]+)$/i.exec(t))) return parseInt(m[1], 16);
  if ((m = /^0b([01]+)$/i.exec(t))) return parseInt(m[1], 2);
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return undefined;
}

export function evaluate(expr: string, sim: Simulator, syms: AsmSymbols, loc?: SourceLoc): EvalResult {
  const e = expr.trim();
  const mem = /^\[(.+)\]$/.exec(e);
  if (mem) {
    const addr = evaluate(mem[1], sim, syms, loc).value;
    if (addr < 0 || addr > 0x21ff) throw new Error(`${hex(addr, 4)} is outside data memory (0x0000-0x21FF)`);
    const v = sim.readData(addr);
    return { value: v, text: fmtByte(v), memoryReference: `data@${addr}` };
  }
  const n = parseNumber(e);
  if (n !== undefined) return { value: n, text: fmtWord(n) };

  const reg = /^r(\d{1,2})$/i.exec(e);
  if (reg && +reg[1] < 32) { const v = sim.readReg(+reg[1]); return { value: v, text: fmtByte(v) }; }
  const def = findCI(syms.defsAt(loc), e);
  if (def !== undefined) { const v = sim.readReg(def); return { value: v, text: fmtByte(v) }; }
  const up = e.toUpperCase();
  if (up in PAIRS) {
    const v = sim.readReg(PAIRS[up]) | (sim.readReg(PAIRS[up] + 1) << 8);
    return { value: v, text: fmtWord(v), memoryReference: `data@${v}` };
  }
  if (up === 'PC') return { value: sim.pc, text: hex(sim.pc, 5) };
  if (up === 'SP') return { value: sim.sp, text: fmtWord(sim.sp), memoryReference: `data@${sim.sp}` };
  const io = findCI(syms.io, e);
  if (io !== undefined) { const v = sim.readData(io); return { value: v, text: `${fmtByte(v)} @${hex(io, 2)}` }; }
  const equ = findCI(syms.equs, e);
  if (equ !== undefined) return { value: equ, text: fmtWord(equ) };
  const label = findCI(syms.labels, e);
  if (label !== undefined) {
    return label.seg === 'dseg'
      ? { value: label.addr, text: `${hex(label.addr, 4)} (data)`, memoryReference: `data@${label.addr}` }
      : { value: label.addr, text: `${hex(label.addr, 4)} (word address, byte ${hex(label.addr * 2, 5)})`, memoryReference: `flash@${label.addr * 2}` };
  }
  throw new Error(`unknown name "${e}"`);
}

/** avra symbols are case-insensitive. */
function findCI<V>(m: Map<string, V>, name: string): V | undefined {
  if (m.has(name)) return m.get(name);
  const l = name.toLowerCase();
  for (const [k, v] of m) if (k.toLowerCase() === l) return v;
  return undefined;
}
