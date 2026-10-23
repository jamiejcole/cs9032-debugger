# Guide for AI agents working on this repo

VS Code extension: an AVR ATmega2560 simulator and debugger for UNSW CS9032 labs (avra-built
`.asm`). Read `docs/BOARD.md` (board wiring and peripheral models) and `docs/CONTRACTS.md` first.

## Release checklist (this has gone wrong before)

1. `npm version <x.y.z> --no-git-tag-version`
2. **`npm run build` first.** `vsce package` does not compile. `out/` is gitignored, so a package
   made without building ships stale JS (0.0.5 shipped with the old keypad code this way).
3. `npx vsce package`. If it complains it can't detect the repository, pass
   `--baseContentUrl https://github.com/jamiejcole/cs9032-debugger/raw/main --baseImagesUrl <same>`.
   (`npm run package` = build + vsce, but hit that error once.)
4. **Verify the package contains the change**, e.g.
   `unzip -p avr-asm-debugger-<v>.vsix extension/out/src/board/keypad.js | grep <something new>`.
5. Commit, push, then `gh release create v<x.y.z> <vsix> --target main ...`. Fixing a bad asset:
   `gh release upload v<x.y.z> <vsix> --clobber`.
6. Tell the user to reinstall (`code --install-extension <vsix> --force`) **and reload the window**;
   the extension host keeps old code until then. Check `~/.vscode/extensions/jamiecole.avr-asm-debugger-*`
   if "it still behaves the old way": old versions sit beside the new one.

`*.vsix` and `out/` are gitignored. Don't commit them. Ask before pushing or releasing.

## Tests

- `npx vitest run test/` (note the path). Plain `npx vitest run` also picks up stale compiled
  `out/test/*.test.js` and fails with "Vitest cannot be imported in a CommonJS module". That is
  pre-existing noise, not a regression.
- `npm run lint` is `tsc --noEmit`; it type-checks tests too. Test fakes must satisfy `PinBus`
  (including `pins`).
- LCD/keypad tests use a `FakeBus` so the test plays the MCU. Copy the one in `test/board/`.

## Hardware accuracy rules (the user cares about these a lot)

The simulator is meant to behave like the real lab board, **quirks included**, so student bugs show
up identically. Don't "fix" the model to be friendlier, and don't add unrequested warnings.

- **Never assume the board matches the printed/documented layout. Check against the student's
  working code and what the real board does.** The keypad is wired transposed: face key (i, j)
  joins `rows[3-j]` to `cols[3-i]`, so lab code needs the table `1 4 7 * / 2 5 8 0 / 3 6 9 # /
  A B C D`. The UI still shows the printed layout. The earlier "natural" model was wrong.
- The LCD follows `LCD_Manual.pdf` (HD44780-style): busy flag and execution times, writes while busy
  are dropped, DDRAM 00-27/40-67, CGRAM **not cleared at power-on** (char 4 powers up as `0b01010`
  rows: the two-bar artifact on the first cell, seen on the real board).
- Clear/Home busy time is 1.64 ms (the manual's 15.2 ms is treated as a typo).
- The user rejected timing/contention warnings (e.g. E pulse width). Don't re-add them.
- Pinout: LCD data PF0-7, RS=PA7, RW=PA5, E=PA6, BE=PA4 (unmodelled), BL=PE3; keypad R0-3=PL7-4,
  C0-3=PL3-0; LED bar PC0-7, PG0-1; buttons PD0/PD1.
- When the user reports a mismatch with the board, ask what their code does or read it (their labs
  live under `Documents/Coding/cs9032/`), reproduce with a test, then fix the model.

## Code gotchas

- **Windows paths:** VS Code gives `c:\...`, avra's `.obj` has `C:\...`. Always compare via
  `pathKey()` in `src/toolchain/obj.ts` (lowercased on win32). A plain string compare made every
  breakpoint show as an unverified grey circle.
- Peripherals implement `BoardPeripheral` (`attach/detach/reset/view/input`) and talk only through
  `PinBus`. `Board.reset()` must be called on session restart (`src/debug/session.ts`).
- The webview (`media/panel.js`) is plain JS with no build step and re-renders every ~33 ms, so
  `click` handlers on rebuilt elements can be lost: use `mousedown`. Card open/closed state is kept
  in `vscode.setState`.
- Config: `.vscode/avr-board.json` or `launch.json` `board`; missing fields fall back to
  `DEFAULT_BOARD` in `src/board/index.ts`. Update `docs/BOARD.md` when wiring or behaviour changes.
- Tooling on this machine is Windows: no Python. Use node, the Edit tool, or bash with care around
  quoting. Git warns about LF/CRLF; ignore.
