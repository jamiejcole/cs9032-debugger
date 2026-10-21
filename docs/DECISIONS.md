# Decisions

## D1 — Simulator core: use avr8js, own the step loop (2026-10-12)

Evaluated avr8js 0.21.1 against the Phase 0 checklist:

| Check | avr8js | Action |
|---|---|---|
| 22-bit PC: CALL/RCALL/ICALL/EICALL/RET/RETI push/pop 3 bytes | ✅ (`pc22Bits` when flash > 128 KB) | test/sim/core2560.test.ts |
| 2560 cycle counts (RCALL 4, CALL 5, ICALL 4, RET 5, RETI 5) | ✅ | tested |
| Interrupt entry: 3 bytes, **5 cycles** (datasheet §7.8.1) | ❌ pushes 3 bytes but charges 2 cycles | our step loop adds 3 |
| One instruction after SEI / RETI before an IRQ (datasheet §7.4.1, §7.8) | ❌ | our step loop |
| EIND, RAMPZ, ELPM, EICALL, EIJMP | ✅ | tested |
| Extended I/O ports H–L (0x100+) | ✅ configs exist | used as-is |
| Timers 0–5, INT0–7, PCINT0–2 for the 2560 vector table | configs are data-driven | `src/sim/device/m2560.ts` |
| Unknown opcodes | ❌ silently NOP | `src/sim/decode.ts` table; step stops with "not implemented" |
| SLEEP / BREAK / SPM | NOP / NOP / NOP | SLEEP sleeps, BREAK stops, SPM → not implemented |
| SRAM size | hard-codes 0x100 register space | pass `RAMEND+1-0x100` so SP starts at 0x21FF |
| Pull-ups | ❌ PINx ignores PORTx pull-up | `PinBus` feeds pull-ups / external drive into PINx |

Writing our own core would duplicate ~900 lines of tested instruction code to fix four
things we can fix from outside. We use `CPU` + `avrInstruction` + peripherals and replace
`CPU.tick()` with our own loop in `src/sim/avr.ts`. Nothing outside `src/sim` imports avr8js.

Known avr8js peripheral gaps, for workstream B (not yet fixed):
- EIFR flag is only set when the INTn mask bit is set (datasheet: set regardless).
- PCMSK write hook updates every port's PCINT with that one register's value; PCICR has no hook.
- USART/ADC not yet configured for the 2560.

## D2 — Tooling
- **Tests:** vitest (TS without a build step, fast). `npm test`.
- **Lint:** `tsc --noEmit` (strict). No ESLint until there's a rule we actually want.
- **Build:** `tsc` to `out/`. No bundler; `vsce package` ships `node_modules` production deps.
- **Runtime deps:** `avr8js` (D1), `@vscode/debugadapter`, `@vscode/debugprotocol`.
- **Dev deps:** `tsx` to run `scripts/*.ts`; `@vscode/debugadapter-testsupport` for DAP tests.

## D3 — Symbols come from avra's map file
`avra -m` lists every label (`L`), `.equ` (`C`) and `.set` (`V`) with its final value,
including those from `m2560def.inc`. We use it instead of re-evaluating expressions. The
source walk only adds what the map lacks: `.def`/`.undef` (position-scoped), the segment of
each label, and which `.equ`s in the device include are I/O registers (the "I/O REGISTER
DEFINITIONS" block).

## D4 — Code vs data
A `.obj` record is data if its source line is a `.db/.dw/.dd/.dq` directive. That is exact,
since avra emits records from those lines, and it needs no reachability analysis.
