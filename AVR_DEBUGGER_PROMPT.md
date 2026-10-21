# Project brief: AVR assembly simulator and debugger for VS Code

You are part of a team of agents building a VS Code extension. It replaces Microchip Studio's
simulator and debugger for **ATmega2560 assembly written for avra**, on **macOS (Apple
Silicon)**. A university student will use it for every remaining lab in a microprocessors
course (COMP9032). Labs cover parallel I/O, push buttons, LED bar, interrupts, timers, LCD,
keypad, motor, PWM and UART. It has to be dependable for those labs, not a demo.

Read this whole file before you start. Then read `docs/CONTRACTS.md` and `docs/DECISIONS.md`
if they exist.

---

## 1. What "done" looks like

The student opens a folder containing `labN.asm` and presses F5. Then:

1. The extension assembles the file with avra. Errors show in the Problems panel with file and
   line.
2. The current source line is highlighted. Step In, Step Over, Step Out, Continue, Pause,
   Restart and Run to Cursor all work. Line breakpoints and breakpoints on labels work.
3. The **Variables** panel shows:
   - r0–r31, each labelled with its `.def` alias, e.g. `r23 (wordCount) = 0x0B (11)`
   - X, Y and Z
   - PC (as a word address and as `label+offset`) and SP
   - the SREG flags I T H S V N Z C, each as a separate boolean
   - a cycle counter, and elapsed time at 16 MHz with a resettable stopwatch
4. The **I/O view** is a webview panel. For every port (A–L) it shows the DDRx, PORTx and PINx
   bits, plus timer, USART, external-interrupt and ADC registers grouped like Microchip
   Studio's I/O view. Clicking a PINx bit drives that input pin, which simulates pressing a
   button.
5. The **virtual lab board**, in the same or a sibling webview, shows the board's peripherals
   connected to the wiring the student configures: LED bar, push buttons, LCD, keypad and so
   on (see §5).
6. Memory: SRAM, flash and EEPROM can be viewed through VS Code's built-in memory view (the
   DAP `readMemory` request).
7. **Watch** accepts register names, `.def` aliases, `.equ` constants and I/O names from
   `m2560def.inc` such as `PORTC` and `PIND`. It also accepts memory forms such as
   `[0x0200]` and `[label]`.
8. Continue has a **real-time** mode, throttled to wall-clock 16 MHz so delay loops and LED
   flashing look right on camera. It also has a **max-speed** mode. Pause takes effect
   quickly in both modes.
9. A **Flash to board** command runs
   `avrdude -c wiring -p m2560 -P <port> -b 115200 -D -U flash:w:<hex>:i`. The port is
   auto-detected from `/dev/cu.usbmodem*` and `/dev/cu.usbserial*` and remembered.

It is installed locally as a `.vsix` with `code --install-extension`. Publishing to the
marketplace is a non-goal.

### Non-goals (do not build)
C, ELF or gdb support. Hardware or JTAG debugging. Other AVR devices (keep the device layer
data-driven so this is possible later, but ship only `m2560`). Marketplace publishing.
Windows or Linux CI. Telemetry.

---

## 2. Environment facts (verified on the student's machine)

- **Assembler:** avra 1.4.2 at `/opt/homebrew/bin/avra`. Include dir:
  `/opt/homebrew/share/avra`. Its built-in default is
  `/opt/homebrew/Cellar/avra/1.4.2/include/avr`.
- **Build command used today:** `avra -I /opt/homebrew/share/avra -fI file.asm -o file.hex`.
  This also writes `file.obj` and `file.eep.hex`. Use `-l file.lst` for a listing and
  `-m file.map` for a symbol map.
- **Flashing:** `/opt/homebrew/bin/avrdude` with the `wiring` programmer at 115200 baud
  (Arduino Mega 2560 bootloader). `-D` is required.
- **CPU clock:** 16 MHz. Student code calibrates busy-wait loops against it, so per-instruction
  cycle counts must be exact.
- Student code begins with `.include "m2560def.inc"`. Treat that file as the source of truth
  for I/O names and addresses. Parse it; don't hand-copy tables.

### 2.1 avra `.obj` format (verified by parsing a real file)

This is the source map. Microchip Studio used the same file to highlight lines. All integers
are big-endian.

| Offset | Size | Meaning |
|---|---|---|
| 0 | u32 | byte offset of the filename table |
| 4 | u32 | byte offset of the first record (26 in observed files) |
| 8 | u8 | record size (9) |
| 9 | u8 | number of source files |
| 10 | — | `"AVR Object File\0"` |

Each record is 9 bytes, from the record offset up to the filename table:
`addr:u24` (flash **word** address), `opcode:u16`, `fileIndex:u8`, `line:u16` (1-based),
`macroFlag:u8`.

The filename table is a list of NUL-terminated strings ending with an empty string. Index 0 is
the main `.asm` file. Included files follow in order (for example the absolute path to
`m2560def.inc`).

Sample: the first records of `reference/lab2/task2.obj` are `0x000 EF0F file0 line37` and
`0x001 E010 file0 line38`.

`.db` and `.dw` data also produce records. Classify an address as code or data using the
labels, the `.cseg` layout and reachability, so that "step" never lands on a string.
`macroFlag` marks code expanded from a macro. Step Over treats a macro expansion as a single
line, and Step In enters it.

---

## 3. Architecture

TypeScript, a single extension package. The debug adapter runs **inline**
(`DebugAdapterInlineImplementation`) in the extension host, so no child process is needed.

```
src/
  sim/        Pure TS, no `vscode` imports, runs under plain Node. CPU, memory, devices, peripherals.
  toolchain/  avra runner, .obj parser, source symbol parser (.def/.equ/labels/.include), avrdude runner.
  debug/      DAP session: maps DAP requests onto sim + toolchain.
  board/      Virtual lab-board peripherals that attach to sim pins (LED bar, buttons, LCD, keypad…).
  ui/         Webview panels (I/O view, virtual board). Talks to debug/ via a typed message protocol.
  extension.ts
test/
  sim/  toolchain/  debug/  e2e/   fixtures/ (asm + prebuilt hex/obj)
reference/    Student's real lab code and board docs. Read-only fixtures.
docs/         CONTRACTS.md, DECISIONS.md, BOARD.md, USER_GUIDE.md
```

### Simulator core decision (Phase 0 gate)

Evaluate **avr8js** (`github.com/wokwi/avr8js`, MIT, TypeScript, used by Wokwi). Its README
says it targets the ATmega328P but is modular enough for the ATmega2560. Do not take that on
trust. Check:

- 22-bit PC behaviour: `CALL`, `RCALL`, `ICALL`, `RET`, `RETI` and interrupt entry push and pop
  **3 bytes**, and use the 2560 cycle counts (e.g. RCALL = 4 cycles, RET = 5).
- `EIND`, `RAMPZ`, `ELPM`, `EICALL`, `EIJMP`.
- Port and register addresses above 0xFF (PORTH–PORTL live in extended I/O).
- Configuring timers 0–5, USART0–3, INT0–7 and PCINT for the 2560's vector table.

Then do one of the following and record the decision in `docs/DECISIONS.md`:
- **Use avr8js,** with 2560 adaptations in `src/sim/device/m2560.ts`. Upstream fixes where
  practical.
- **Write our own core.** All of the 2560's instructions, table-driven decode, cycle-exact. Take
  only the peripherals' *design* from avr8js.

Either way, everything above `src/sim` talks only to the `Simulator` interface in
`docs/CONTRACTS.md`, never to avr8js types directly.

---

## 4. Contracts first

Before any workstream writes implementation code, the **lead agent** writes
`docs/CONTRACTS.md` and the matching `.ts` interface files. Other agents may propose changes
to a contract but must not edit one themselves. The minimum set:

- `Simulator`: `load(hex, eep?)`, `reset()`, `step(): StepResult`,
  `runUntil(predicate, maxCycles)`, `readReg/writeReg`, `readData/writeData`,
  `readFlash`, `readEeprom`, `pc`, `sp`, `sreg`, `cycles`, `pins` (a `PinBus`),
  `onBreak`, and interrupt-pending state.
- `PinBus`: per-pin resolved level and direction (DDR, PORT, pull-up, external drive).
  Externals drive or read pins through `drive(pin, level | 'z')` and
  `subscribe(pin, cb)`. Pins are named `"PC6"`, `"PG0"` and so on.
- `SourceMap`: `addrToLoc(wordAddr)`, `locToAddrs(file, line)`, `isCode(addr)`,
  `isMacro(addr)`.
- `Symbols`: labels → word address, `.def` → register, `.equ` → value, and I/O names →
  data address, taken from the parsed include.
- `BoardPeripheral`: `attach(pinBus, config)`, `render state for UI`, `handle UI input`.
- `UiProtocol`: the messages exchanged between `debug/` and the webviews, as a discriminated
  union.

---

## 5. Virtual lab board

The physical board is an Arduino Mega 2560 R3 on a carrier board. Its peripherals connect to
MCU pins **with jumper wires that change from lab to lab**, so wiring must be configuration,
never hard-coded.

Peripherals on the board (see `reference/board/Board Test Procedure.pdf` for the default
test wiring):
- **LED bar:** 10 LEDs. Lab 2 uses PC0–PC7 plus PG0–PG1. PC0 is the bottom LED.
- **Push buttons:** PB0 and PB1, active-low, wired to PORTD and used with the internal
  pull-up. They are also used as INT0/INT1 sources.
- **LCD:** HD44780-compatible, 16×2. Data on PORTF and control lines on PORTA in the test
  wiring. Emulate the instruction set, busy flag and timing well enough for course-style
  drivers.
- **Keypad:** 4×4 matrix on PORTL (rows and columns scanned in software).
- **Motor** with an optical speed sensor (feeds an interrupt and counter input), **audio**
  output and a **potentiometer** on an ADC input. Lower priority, but stub their interfaces.

Wiring lives in `.vscode/avr-board.json`, or in `launch.json` under `board`. Example:

```json
{ "ledBar": ["PC0","PC1","PC2","PC3","PC4","PC5","PC6","PC7","PG0","PG1"],
  "buttons": { "PB0": "PD0", "PB1": "PD1" },
  "lcd": { "data": "PORTF", "rs": "PA..", "rw": "PA..", "e": "PA.." },
  "keypad": { "rows": ["PL..."], "cols": ["PL..."] } }
```

Fill in the real defaults in `docs/BOARD.md` from the board PDF. Ask the student about
anything the PDF leaves ambiguous rather than guessing.

Buttons support momentary press with hold and release, and **toggle-latch**. Latching is
needed because stepping one line at a time while holding a mouse button is impossible.

---

## 6. Workstreams (one agent each; parallel after Phase 0)

| ID | Owner dir | Scope | First deliverable |
|---|---|---|---|
| **L** Lead / integrator | `docs/`, `src/extension.ts`, `package.json` | Contracts, decisions, merges, cross-cutting review, release builds | `CONTRACTS.md` and interface files |
| **A** CPU core | `src/sim/` (core) | Phase 0 evaluation, then full 2560 instruction set, cycle-exact, interrupts, sleep, watchdog no-op | Phase 0 report and instruction tests |
| **B** Peripherals | `src/sim/peripherals/` | GPIO with pull-ups and PINx-write-toggles-PORTx, Timers 0–5 (normal, CTC, PWM modes), INT0–7, PCINT, USART0, ADC, EEPROM | GPIO and INTn first, which unblocks lab 2 and the interrupts lab |
| **C** Toolchain | `src/toolchain/` | avra runner and error parsing into Problems, `.obj` parser, symbol parser (`.def` scoping and `.undef`, `.equ`, `.set`, labels, `.include`), `m2560def.inc` parser, avrdude runner and port picker | `.obj` parser tested against `reference/lab2/task2.obj` |
| **D** Debug adapter | `src/debug/` | Every DAP request in §1: stepping semantics, breakpoints, variables and scopes, watch evaluation, readMemory and writeMemory, setVariable for registers and flags, real-time and max-speed run loop | Step through `task2.asm` with highlighting and registers |
| **E** UI | `src/ui/` | I/O view webview and virtual board webview. VS Code theme-aware, keyboard accessible | Port bit grid and LED bar and buttons |
| **F** Board peripherals | `src/board/` | LED bar, buttons, HD44780 LCD, keypad matrix, motor and encoder stub, pot to ADC | LED bar and buttons, then LCD |
| **Q** QA | `test/e2e/`, `test/fixtures/` | Headless end-to-end scenarios (§7), regression fixtures for each lab, review of other agents' PRs for tests | Lab 2 e2e scenario |

Phase 0, run by the lead with agent A, takes about a day: the contracts, the avr8js decision,
and a throwaway headless script that runs `task2.hex`, presses PD1 and prints PORTC/PORTG.
All other workstreams start when Phase 0 merges.

Then go breadth-first. The **lab 2 path** comes first: GPIO, buttons, LED bar, stepping and
registers. That gives the student something usable end-to-end. Next come interrupts and
timers, then the LCD and keypad, then UART, ADC and the motor.

---

## 7. Acceptance tests (must stay green)

All tests run headless under `npm test` (vitest or node:test, whichever the lead picks).
They need no VS Code instance, apart from a small `@vscode/test-electron` smoke suite.

- **Instruction tests:** for every opcode, check the result registers, every SREG flag and
  the cycle count against the AVR Instruction Set Manual. Include 2560-specific behaviour
  (3-byte return addresses).
- **Source map:** `task2.obj` maps word 0 to `task2.asm:37`. Every `RCALL` target resolves to a
  label. `.db` string addresses are reported as data.
- **Lab 2 end-to-end** (`reference/lab2/task2.asm`), driven by simulated time:
  - Press and release PD1 (holding it for longer than the debounce). Upper LEDs
    (PC6, PC7, PG0, PG1 = bits 0–3) show **11**. Then **14**, then **15**.
  - The 4th press (16 words) makes PC0–PC5 toggle at roughly 200 ms. A press during
    flashing stops it.
  - Press 5 (37 words) flashes again, and the stop press works.
  - Measured with the real-time clock, `delay` with `waitTime=20` lasts about 20 ms ±2%.
    This checks cycle accuracy.
- **DAP:** a scripted session (`@vscode/debugadapter-testsupport`) sets a breakpoint at
  `countWords`, continues, steps 5 times, reads `r23`, and steps over `RCALL delay` in a
  single request.
- Each later lab adds its own e2e scenario under `test/e2e/labN/` with the student's code as
  a fixture.

---

## 8. Rules for every agent

- Stay inside your owner directory. Cross-boundary changes go through the lead as a short
  proposal in `docs/proposals/`.
- One branch and one PR per coherent change. Keep PRs small. Before you open one,
  `npm run lint && npm test` must pass.
- No new runtime dependency without a line in `docs/DECISIONS.md` saying why. Expected
  dependencies: `@vscode/debugadapter`, `@vscode/debugprotocol`, possibly `avr8js`. Nothing
  heavy in the webview; plain TS or Lit is fine and a framework isn't needed.
- `src/sim` must never import `vscode`. Keep it runnable under Node so it can be tested and
  reused.
- Be exact over clever. When the datasheet and an existing simulator disagree, follow the
  **ATmega2560 datasheet / AVR Instruction Set Manual**, cite the section in a comment, and
  add a test.
- Never silently ignore an unimplemented opcode or register. Stop with a clear "not
  implemented: <thing> at <file:line>" message in the debug console, so the student knows
  the simulator is the problem, not their code.
- Every user-visible behaviour gets a line in `docs/USER_GUIDE.md`.
- If a requirement here is ambiguous, write the question in `docs/QUESTIONS.md` and continue
  with the most conservative interpretation. Do not stall.

---

## 9. Reference material to copy into `reference/` before starting

The student does this:

- `reference/lab2/`: `task2.asm`, `task2.hex`, `task2.obj`, `Makefile`, `lab2.pdf`
  (from `~/Desktop/cs9032/lab2/task/`)
- `reference/board/`: `Introduction_to_AVR_Microprocessor_Development_Board.pdf`, plus
  `lab_board_information/Board Test Procedure.pdf` and `Board Evaluation Form.xlsx`
  (from `~/Desktop/cs9032/lab2/`)
- Later labs: add each lab's spec PDF and solution under `reference/labN/` as they come.
