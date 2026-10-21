import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ObjSourceMap, parseObj } from '../../src/toolchain/obj';
import { AsmSymbols } from '../../src/toolchain/symbols';
import { AVRA_BUILTIN_INC, defaultIncludeDirs, parseAvraOutput } from '../../src/toolchain/avra';

const ref = path.resolve('reference/lab2/task');
const fx = path.resolve('test/fixtures/lab2');
const asm = path.join(ref, 'task2.asm');
const INC = [...defaultIncludeDirs(), ...AVRA_BUILTIN_INC];

describe('avra .obj source map (reference/lab2/task/task2.obj)', () => {
  const sm = new ObjSourceMap(path.join(ref, 'task2.obj'));
  const syms = new AsmSymbols(asm, readFileSync(path.join(fx, 'task2.map'), 'utf8'), INC);

  it('parses the header and first records', () => {
    const { records, files } = parseObj(readFileSync(path.join(ref, 'task2.obj')));
    expect(files[0]).toBe('task2.asm');
    expect(records[0]).toMatchObject({ addr: 0, opcode: 0xef0f, file: 0, line: 37 });
    expect(records[1]).toMatchObject({ addr: 1, opcode: 0xe010, line: 38 });
  });

  it('maps word 0 to task2.asm:37 and back', () => {
    expect(sm.addrToLoc(0)).toEqual({ file: asm, line: 37 });
    expect(sm.locToAddrs(asm, 37)).toEqual([0]);
  });

  it('resolves every RCALL target to a label', () => {
    const labelAddrs = new Set([...syms.labels.values()].map((l) => l.addr));
    const { records } = parseObj(readFileSync(path.join(ref, 'task2.obj')));
    const rcalls = records.filter((r) => sm.isCode(r.addr) && (r.opcode & 0xf000) === 0xd000);
    expect(rcalls.length).toBeGreaterThan(5);
    for (const r of rcalls) {
      const k = r.opcode & 0x0fff;
      const target = r.addr + 1 + (k & 0x800 ? k - 0x1000 : k);
      expect(labelAddrs.has(target), `rcall at ${r.addr} -> ${target}`).toBe(true);
    }
  });

  it('reports .db/.dw words as data', () => {
    const text1 = syms.labels.get('text1')!.addr;
    const ptrs = syms.labels.get('textPointers')!.addr;
    expect(sm.isCode(text1)).toBe(false);
    expect(sm.isCode(text1 + 3)).toBe(false);
    expect(sm.isCode(ptrs)).toBe(false);
    expect(sm.isCode(syms.labels.get('delay')!.addr)).toBe(true);
  });

  it('parses symbols: labels, .def, .equ and I/O names', () => {
    expect(syms.labels.get('countWords')).toEqual({ addr: 0x45, seg: 'cseg' });
    expect(syms.defsAt().get('wordCount')).toBe(23);
    expect(syms.defsAt().get('ZL')).toBe(30);
    expect(syms.io.get('PORTC')).toBe(0x28);
    expect(syms.io.get('PIND')).toBe(0x29);
    expect(syms.io.get('PORTL')).toBe(0x10b);
    expect(syms.io.get('SREG')).toBe(0x5f);
    expect(syms.io.has('PORTC0')).toBe(false); // bit names aren't registers
    expect(syms.equs.get('INT0addr')).toBe(2);
  });

  it('scopes .def by position (.undef / redefinition)', () => {
    const src = '.def a = r16\nnop\n.undef a\n.def a = r17\nnop\n';
    const s = new AsmSymbols('/x/m.asm', '', [], () => src);
    expect(s.defsAt({ file: '/x/m.asm', line: 2 }).get('a')).toBe(16);
    expect(s.defsAt({ file: '/x/m.asm', line: 5 }).get('a')).toBe(17);
  });

  it('parses avra diagnostics', () => {
    const d = parseAvraOutput('bad.asm(3) : Error   : Unknown mnemonic/macro: bogus\nWarning : No .DEVICE\n', '/w');
    expect(d).toEqual([{ file: path.resolve('/w/bad.asm'), line: 3, severity: 'error', message: 'Unknown mnemonic/macro: bogus' }]);
  });
});
