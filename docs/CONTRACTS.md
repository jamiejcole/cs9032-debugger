# Contracts

The `.ts` files are the source of truth. This page says where each one lives and the rules
around it. Only the lead edits these. To change one, write a proposal in `docs/proposals/`.

| Contract | File | Implemented by |
|---|---|---|
| `Simulator`, `PinBus`, `StepResult`, `StopReason` | `src/sim/types.ts` | `src/sim/avr.ts` (`AvrSim`) |
| `SourceMap` | `src/toolchain/types.ts` | `src/toolchain/obj.ts` (`ObjSourceMap`) |
| `Symbols` | `src/toolchain/types.ts` | `src/toolchain/symbols.ts` (`AsmSymbols`) |
| `BuildResult`, `Diagnostic` | `src/toolchain/types.ts` | `src/toolchain/avra.ts` |
| `BoardPeripheral`, `BoardConfig`, `PeripheralView/Input` | `src/board/types.ts` | `src/board/*` |
| `ToWebview` / `FromWebview` | `src/ui/protocol.ts` | `src/debug/` ↔ `src/ui/` |

## Units and conventions
- **Flash addresses are word addresses** everywhere (PC, labels, SourceMap), except in
  `readFlash(byteAddr, len)` and the DAP `readMemory` for flash.
- **Data addresses** are data-space: r0–r31 = 0x00–0x1F, I/O = 0x20–0x5F, extended I/O =
  0x60–0x1FF, SRAM = 0x200–0x21FF. `Symbols.io` stores data-space addresses (`PORTC` = 0x28).
- **Pins** are named `P<port><bit>`: `PC6`, `PG0`, `PL7`. Port G has only PG0–PG5.
- `Simulator.writeData` behaves like an `ST` instruction (peripheral hooks fire). Writing a
  1 to a PINx bit toggles PORTx.
- `Simulator.step()` never throws on bad code. It returns `error: "not implemented: …"`.
- `PinBus.drive(pin, 'z')` releases a pin. An undriven input with PORTx=1 reads high
  (pull-up). With PORTx=0 it reads 0 and reports `level: 'z'`.
- `src/sim` must not import `vscode`.

## Lifecycle
`load()` → `reset()` rebuilds the CPU and peripherals. The `PinBus` object, its external
drives and its subscribers **survive** reset, so board peripherals stay attached across
Restart. EEPROM contents survive reset but not `load()`.
