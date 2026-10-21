// avra .obj reader -> SourceMap. Format: AVR_DEBUGGER_PROMPT.md §2.1 (big-endian).
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { SourceLoc, SourceMap } from './types';

export interface ObjRecord { addr: number; opcode: number; file: number; line: number; macro: boolean }

export function parseObj(buf: Uint8Array): { records: ObjRecord[]; files: string[] } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fileTable = dv.getUint32(0), first = dv.getUint32(4), size = buf[8];
  const magic = Buffer.from(buf.subarray(10, 25)).toString('latin1');
  if (magic !== 'AVR Object File') throw new Error('not an avra .obj file');
  const records: ObjRecord[] = [];
  for (let o = first; o + size <= fileTable; o += size) {
    records.push({
      addr: (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2],
      opcode: dv.getUint16(o + 3),
      file: buf[o + 5],
      line: dv.getUint16(o + 6),
      macro: buf[o + 8] !== 0,
    });
  }
  const files: string[] = [];
  let s = fileTable;
  for (;;) {
    const end = buf.indexOf(0, s);
    if (end <= s) break; // empty string terminates
    files.push(Buffer.from(buf.subarray(s, end)).toString('utf8'));
    s = end + 1;
  }
  return { records, files };
}

// A record is data if its source line is a .db/.dw/.dd/.dq directive (optionally after a label).
const DATA_LINE = /^\s*(?:[A-Za-z_][\w]*:\s*)?\.(db|dw|dd|dq)\b/i;

export class ObjSourceMap implements SourceMap {
  private byAddr = new Map<number, ObjRecord & { code: boolean }>();
  private byLoc = new Map<string, number[]>();
  readonly files: string[];

  /** `baseDir` resolves relative filenames (avra records the main file as given on its command line). */
  constructor(objPath: string, baseDir = path.dirname(objPath), readText = (f: string) => readFileSync(f, 'utf8')) {
    const { records, files } = parseObj(readFileSync(objPath));
    this.files = files.map((f) => path.resolve(baseDir, f));
    const lines = new Map<number, string[]>();
    const srcLine = (fi: number, ln: number) => {
      if (!lines.has(fi)) {
        try { lines.set(fi, readText(this.files[fi]).split(/\r?\n/)); } catch { lines.set(fi, []); }
      }
      return lines.get(fi)![ln - 1] ?? '';
    };
    for (const r of records) {
      const code = !DATA_LINE.test(srcLine(r.file, r.line));
      this.byAddr.set(r.addr, { ...r, code });
      if (!code) continue;
      const key = `${this.files[r.file]}:${r.line}`;
      const list = this.byLoc.get(key) ?? [];
      list.push(r.addr);
      this.byLoc.set(key, list);
    }
  }

  addrToLoc(wordAddr: number): SourceLoc | undefined {
    const r = this.byAddr.get(wordAddr);
    return r && { file: this.files[r.file], line: r.line };
  }
  locToAddrs(file: string, line: number): number[] {
    return this.byLoc.get(`${path.resolve(file)}:${line}`) ?? [];
  }
  isCode(wordAddr: number): boolean { return this.byAddr.get(wordAddr)?.code ?? false; }
  isMacro(wordAddr: number): boolean { return this.byAddr.get(wordAddr)?.macro ?? false; }
  /** All lines that have code, for breakpoint validation. */
  codeLines(file: string): number[] {
    const prefix = `${path.resolve(file)}:`;
    return [...this.byLoc.keys()].filter((k) => k.startsWith(prefix)).map((k) => +k.slice(prefix.length));
  }
}
