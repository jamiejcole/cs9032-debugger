# AVR Assembly Debugger: user guide

## Install
```sh
npm install && npm run package
code --install-extension avr-asm-debugger-0.0.2.vsix
```
Needs avra and, for flashing, avrdude. The paths are settings
(`avr.avraPath`, `avr.avrdudePath`, `avr.includeDir`). Left empty, they default to homebrew
(`/opt/homebrew/...`) on macOS and to `avra`/`avrdude` on PATH elsewhere.

On Windows there's no avra package, so build it with MinGW (`scoop install mingw`):
```powershell
git clone --branch 1.4.2 https://github.com/Ro5bert/avra C:\tools\avra
cd C:\tools\avra; mingw32-make
```
Then set `avr.avraPath` to `C:\tools\avra\src\avra.exe` (or put `C:\tools\avra\src` on PATH).
The include dir is found from there (`C:\tools\avra\includes`).

## Debugging
- Open `labN.asm` and press **F5**. No `launch.json` is needed: the open `.asm` file is
  assembled and debugged. To fix the file, add a launch config `{ "type": "avr", "request": "launch", "program": "${workspaceFolder}/lab3.asm" }`.
- **Assembly errors** appear in the Problems panel with file and line, and the session
  doesn't start.
- The session **stops on entry** at the first instruction. Set `"stopOnEntry": false` to run
  straight away.
- **Step Over** (F10) runs a whole source line, including any `rcall`/`call`, and any
  interrupt that fires during it. **Step In** (F11) enters calls and interrupt handlers.
  **Step Out** (⇧F11) runs until the current subroutine or ISR returns.
- Stepping a line that jumps to itself (`end: rjmp end`) does one iteration per step.
- A **macro** use is one line for Step Over.
- **Instruction stepping:** use the disassembly view or a step with "instruction"
  granularity to execute exactly one instruction.
- **Restart** (⇧⌘F5) re-assembles the file, so edits take effect, then resets the CPU.
  EEPROM and latched buttons survive a restart.
- **Breakpoints:** click in the gutter. A breakpoint on a blank, comment or label-only line
  moves to the next line with code. **Function breakpoints** (Breakpoints panel → +) take
  a code label, e.g. `countWords`.
- **Run to Cursor** (right-click in the editor) works.
- A `BREAK` instruction stops like a breakpoint.
- If the program runs into `.db`/`.dw` data or hits an opcode the ATmega2560 doesn't have,
  it stops and the Debug Console says why, e.g. `not implemented: opcode 0xffff at word 0x1a0`.
  That means the simulator or the program counter is the problem, not a logic bug in a line.
- `SLEEP` (with `SE` set in `SMCR`) sleeps until an interrupt.

## Variables panel
- **Registers:** `r0`–`r31`, each with its `.def` names as they stand at the current line,
  e.g. `r23 (wordCount) = 0x0B (11)`. Double-click a value to edit it (`0x1F`, `$1F`,
  `0b11111`, `31`).
- **Status & Pointers:** PC (`label+offset`), SP, X, Y, Z, SREG, and the flags I T H S V N Z C
  as editable `true`/`false`.
- **Time:** cycle count, elapsed time at 16 MHz, and a **Stopwatch**. Set the stopwatch to
  any value, or run **AVR: Reset Stopwatch**, to zero it.

## Watch and hover
Accepts `r16`, `.def` names (`wordCount`), `X`/`Y`/`Z`, `PC`, `SP`, I/O names (`PORTC`,
`PIND`; shows the value and address), `.equ` constants, labels (shows the address), numbers,
and memory: `[0x0200]`, `[label]`, `[X]` (one SRAM byte). Names are case-insensitive, as in
avra.

## Memory
Pointers (SP, X, Y, Z, `[addr]` watches, data labels) have a memory reference. Use the
binary-data icon next to them to open VS Code's memory view. Data memory is writable.
Flash (from a code label watch) and EEPROM are read-only.

## Real-time vs max speed
**Real-time** (the default) throttles Continue and steps to wall-clock 16 MHz, so delay loops
and LED flashing look right. **Max speed** runs as fast as possible, about 5× real time.
Toggle with **AVR: Toggle Real-time / Max Speed** (also on the debug toolbar) or the
`avr.realtime` setting / `"realtime"` in launch.json. Pause responds within a few
milliseconds in both modes.

## Board & I/O panel
Opens beside the editor when a session starts (**AVR: Show Board & I/O**).
- **LED bar:** LED 0 is at the bottom.
- **Push buttons:** hold the mouse (or Space/Enter) to press. Tick **latch** to keep the
  button pressed while you step, and untick it to release.
- **I/O registers** are grouped as in Microchip Studio: PORTA–PORTL, the timers, EXINT,
  USART0–3, ADC, EEPROM and CPU. Click a group to expand it.
- **PINx bits:** click to drive the pin to the opposite level, which simulates a button or an
  input signal. **Shift+click** releases it. Driven pins have an orange outline.
- **Other register bits:** click to toggle the bit. This writes the register as `sts` would.

## Wiring
See `docs/BOARD.md`. Put `.vscode/avr-board.json` in the lab folder.

## Flash to board
**AVR: Flash to Board** (also the editor title bar on `.asm` files) saves, assembles, then
runs `avrdude -c wiring -p m2560 -P <port> -b 115200 -D -U flash:w:<hex>:i`. The port is
found from `/dev/cu.usbmodem*` and `/dev/cu.usbserial*` (on Windows, the `COM` ports). If there are several, you pick one,
and it's remembered for the workspace. avrdude output goes to the **AVR** output channel.
