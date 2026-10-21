// Symbols from avra's map file (labels, .equ, .set: authoritative values) plus a source walk
// for what the map omits: .def/.undef (position-scoped) and which segment a label lives in.
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import type { SourceLoc, Symbols } from './types';

type DefEvent = { file: string; line: number; name: string; reg: number | null };

export class AsmSymbols implements Symbols {
  labels = new Map<string, { addr: number; seg: 'cseg' | 'dseg' | 'eseg' }>();
  equs = new Map<string, number>();
  io = new Map<string, number>();
  /** I/O register name -> bit names, index 0 = bit 0 (from the device include's BIT DEFINITIONS). */
  ioBits = new Map<string, (string | null)[]>();
  private defEvents: DefEvent[] = [];

  /**
   * @param mainAsm  absolute path of the main .asm
   * @param mapText  contents of avra's -m map file
   * @param includeDirs  where `.include "x"` is searched after the including file's dir
   */
  constructor(mainAsm: string, mapText: string, includeDirs: string[], readText = (f: string) => readFileSync(f, 'utf8')) {
    const segOf = new Map<string, 'cseg' | 'dseg' | 'eseg'>();
    this.walk(path.resolve(mainAsm), includeDirs, readText, segOf, { seg: 'cseg' }, new Set());

    // Map lines: "name<TAB(s)>kind<TAB>hex<TAB>dec". L = label, C = .equ, V = .set.
    for (const line of mapText.split(/\r?\n/)) {
      const [name, kind, hex] = line.split(/\t+/);
      if (!name || !hex || name.startsWith('__')) continue;
      const v = parseInt(hex, 16);
      if (kind === 'L') this.labels.set(name, { addr: v, seg: segOf.get(name.toLowerCase()) ?? 'cseg' });
      else if (kind === 'C' || kind === 'V') this.equs.set(name, v);
    }
  }

  defsAt(loc?: SourceLoc): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of this.defEvents) {
      if (loc && e.file === path.resolve(loc.file) && e.line > loc.line) break;
      if (e.reg === null) out.delete(e.name);
      else out.set(e.name, e.reg);
    }
    return out;
  }

  /** Every alias ever defined for register n, for display when no location is known. */
  aliasesFor(reg: number, loc?: SourceLoc): string[] {
    return [...this.defsAt(loc)].filter(([, r]) => r === reg).map(([n]) => n);
  }

  private walk(file: string, dirs: string[], read: (f: string) => string,
    segOf: Map<string, 'cseg' | 'dseg' | 'eseg'>, st: { seg: 'cseg' | 'dseg' | 'eseg' }, seen: Set<string>) {
    if (seen.has(file)) return;
    seen.add(file);
    let text: string;
    try { text = read(file); } catch { return; }
    const isDevInc = /m\d+def\.inc$/i.test(file);
    let inIoBlock = false, inBits = false, bitReg: string | undefined;
    text.split(/\r?\n/).forEach((raw, i) => {
      const lineNo = i + 1;
      if (isDevInc && raw.includes('I/O REGISTER DEFINITIONS')) inIoBlock = true;
      else if (isDevInc && /^; \*{5} /.test(raw)) {
        inIoBlock = false;
        if (raw.includes('BIT DEFINITIONS')) inBits = true;
        else if (/DECLARATIONS|INTERRUPT VECTORS/.test(raw)) inBits = false;
      }
      let h: RegExpExecArray | null;
      if (inBits && (h = /^;\s*(\w+)\s+-\s/.exec(raw))) bitReg = h[1];
      const line = raw.replace(/;.*$/, '').trim();
      if (!line) return;
      let m: RegExpExecArray | null;
      if ((m = /^([A-Za-z_]\w*):/.exec(line))) segOf.set(m[1].toLowerCase(), st.seg);
      const body = line.replace(/^[A-Za-z_]\w*:\s*/, '');
      if ((m = /^\.(cseg|dseg|eseg)\b/i.exec(body))) st.seg = m[1].toLowerCase() as typeof st.seg;
      else if ((m = /^\.def\s+([A-Za-z_]\w*)\s*=\s*r(\d+)\s*$/i.exec(body)))
        this.defEvents.push({ file, line: lineNo, name: m[1], reg: +m[2] });
      else if ((m = /^\.undef\s+([A-Za-z_]\w*)/i.exec(body)))
        this.defEvents.push({ file, line: lineNo, name: m[1], reg: null });
      else if (inIoBlock && (m = /^\.equ\s+(\w+)\s*=\s*(0x[0-9a-f]+|\d+)/i.exec(body))) {
        const v = Number(m[2]);
        this.io.set(m[1], v < 0x40 ? v + 0x20 : v); // I/O space -> data space
      } else if (inBits && bitReg && (m = /^\.equ\s+(\w+)\s*=\s*([0-7])\s*$/i.exec(body))) {
        const bits = this.ioBits.get(bitReg) ?? new Array<string | null>(8).fill(null);
        bits[+m[2]] = m[1];
        this.ioBits.set(bitReg, bits);
      } else if ((m = /^\.include\s+"([^"]+)"/i.exec(body))) {
        const cands = [path.resolve(path.dirname(file), m[1]), ...dirs.map((d) => path.resolve(d, m![1]))];
        const hit = cands.find((c) => existsSync(c));
        if (hit) this.walk(hit, dirs, read, segOf, st, seen);
      }
    });
  }
}
