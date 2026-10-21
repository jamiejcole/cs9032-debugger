// Scripted DAP session (AVR_DEBUGGER_PROMPT.md §7). Runs the adapter in-process over TCP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import * as net from 'node:net';
import * as path from 'node:path';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AvrDebugSession } from '../../src/debug/session';

let server: net.Server;
let dc: DebugClient;
// Assemble a copy so the test doesn't write into the fixtures dir.
const dir = mkdtempSync(path.join(tmpdir(), 'avr-dap-'));
cpSync('test/fixtures/lab2/task2.asm', path.join(dir, 'task2.asm'));
const program = path.join(dir, 'task2.asm');
const lines = readFileSync(program, 'utf8').split('\n');
const lineOf = (re: RegExp, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l)) + 1;

beforeAll(async () => {
  server = net.createServer((socket) => {
    const s = new AvrDebugSession();
    s.setRunAsServer(true);
    s.start(socket, socket);
  }).listen(0);
  dc = new DebugClient('node', '', 'avr');
  await dc.start((server.address() as net.AddressInfo).port);
});
afterAll(async () => { await dc.stop(); server.close(); });

const r23 = async (frameId: number) => {
  const scopes = await dc.scopesRequest({ frameId });
  const vars = await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
  return vars.body.variables[23];
};
const latchPB1 = { type: 'board', id: 'buttons', input: { kind: 'button', name: 'PB1', action: 'toggleLatch' } };
const top = async () => (await dc.stackTraceRequest({ threadId: 1 })).body.stackFrames[0];

describe('DAP', () => {
  it('breakpoints, stepping, registers, step over RCALL delay', async () => {
    const rcallDelay = lineOf(/RCALL delay/i, lineOf(/^main:/));
    await dc.initializeRequest();
    const initialized = dc.waitForEvent('initialized');
    const launched = dc.launchRequest({ program, stopOnEntry: false, realtime: false } as any);
    await initialized;
    await dc.setBreakpointsRequest({ source: { path: program }, breakpoints: [{ line: rcallDelay }] });
    await dc.customRequest('avr/ui', latchPB1); // hold PB1 (PD1) down
    let stop = dc.waitForEvent('stopped');
    await dc.configurationDoneRequest();
    await launched;
    expect((await stop).body.reason).toBe('breakpoint');
    expect((await top()).line).toBe(rcallDelay);

    // Step over RCALL delay: one request, ~20 ms of simulated time.
    const before = await cycles();
    await stopAfter(dc.nextRequest({ threadId: 1 }));
    expect((await top()).line).toBe(lineOf(/SBIS PIND, 1/));
    const ms = ((await cycles()) - before) / 16000;
    expect(ms).toBeGreaterThan(19.5);
    expect(ms).toBeLessThan(20.5);

    // Release the button, break at countWords.
    await dc.customRequest('avr/ui', latchPB1); // and release it
    const fbp = await dc.setFunctionBreakpointsRequest({ breakpoints: [{ name: 'countWords' }] });
    expect(fbp.body.breakpoints[0].verified).toBe(true);
    await dc.setBreakpointsRequest({ source: { path: program }, breakpoints: [] });
    expect((await stopAfter(dc.continueRequest({ threadId: 1 }))).body.reason).toBe('function breakpoint');
    expect((await top()).name).toBe('countWords');

    for (let i = 0; i < 5; i++) await stopAfter(dc.stepInRequest({ threadId: 1 }));
    const f = await top();
    const v = await r23(f.id);
    expect(v.name).toBe('r23 (wordCount)');
    expect(v.value).toMatch(/^0x[0-9A-F]{2} \(\d+\)$/);

    const watch = await dc.evaluateRequest({ expression: 'PORTC', context: 'watch' });
    expect(watch.body.result).toMatch(/@0x28$/);
    const mem = await dc.evaluateRequest({ expression: '[0x0200]', context: 'watch' });
    expect(mem.body.memoryReference).toBe('data@512');
  });
});

async function stopAfter(req: Promise<unknown>) { const ev = dc.waitForEvent('stopped'); await req; return ev; }
async function cycles() {
  const scopes = await dc.scopesRequest({ frameId: 0 });
  const vars = await dc.variablesRequest({ variablesReference: scopes.body.scopes[2].variablesReference });
  return Number(vars.body.variables[0].value);
}
