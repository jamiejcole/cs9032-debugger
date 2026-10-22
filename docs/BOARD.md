# Virtual lab board

Wiring is configuration, not code. Put it in `.vscode/avr-board.json` in the lab folder, or
under `"board"` in `launch.json` (which wins). Any field you leave out uses the **lab 2
default** below. Restart the debug session to apply changes.

## Lab 2 default (what the simulator uses out of the box)

```json
{
  "ledBar": ["PC0","PC1","PC2","PC3","PC4","PC5","PC6","PC7","PG0","PG1"],
  "buttons": { "PB0": "PD0", "PB1": "PD1" }
}
```

- `ledBar[0]` is the **bottom** LED. An LED is lit when its pin is an output driven high.
- Buttons are active-low. Pressed pulls the pin to 0. Released leaves it floating, so the
  program must enable the pull-up (`PORTx` bit = 1) to read 1, as on the real board.
- PB0 on PD0 = INT0 and PB1 on PD1 = INT1, for the interrupts lab.

## Correct board wiring

`Board Test Procedure.pdf` is **wrong** about the LED bar (it says LED0/LED1 = PG2/PG3) and
unclear about the buttons. The student supplied this corrected table:

| Device pin | MCU pin | Config field |
|---|---|---|
| LCD D0–D7 | PF0–PF7 | `lcd.data: "PORTF"` |
| LCD RS / E / RW / BE | PA7 / PA6 / PA5 / PA4 | `lcd.rs`, `lcd.e`, `lcd.rw` |
| LCD backlight (BL) | PE3 | `lcd.bl` |
| LED bar LED0, LED1 | PG0, PG1 | |
| LED bar LED2–LED9 | PC0–PC7 | |
| PB0 / PB1 | PD0 ("RDX4") / PD1 ("RDX3") | `buttons` |
| Keypad R0, R1, R2, R3 | PL7, PL6, PL5, PL4 | `keypad.rows` |
| Keypad C0, C1, C2, C3 | PL3, PL2, PL1, PL0 | `keypad.cols` |
| Motor drive (Mot) | PE2 | `motor.drive` |
| Motor optical sensor (OpO) | "TDX2" on the Port D header (PD2?, unconfirmed) | `motor.sensor` |
| Motor LED | PA3 | — |
| Motor OpE | +5 V | — |
| POT / LDR | PK8 / PK9 (ADC8 / ADC9) | `pot.adcChannel: 8` |
| Audio Ain / ASD / MiO (unused) | older table: PE3 / PG1 / PK10 (PE3 is the LCD backlight per the newer table) | — |

The LED bar pins are the same set the lab 2 default uses. `ledBar` lists them from the
**bottom** LED up. The default puts PC0 at the bottom and PG1 at the top, which matches
lab 2's code ("upper 4 = PC6, PC7, PG0, PG1").

Full config for the board:

```json
{
  "ledBar": ["PC0","PC1","PC2","PC3","PC4","PC5","PC6","PC7","PG0","PG1"],
  "buttons": { "PB0": "PD0", "PB1": "PD1" },
  "lcd": { "data": "PORTF", "rs": "PA7", "rw": "PA5", "e": "PA6", "bl": "PE3" },
  "keypad": { "rows": ["PL7","PL6","PL5","PL4"], "cols": ["PL3","PL2","PL1","PL0"] }
}
```

## LCD and keypad simulation

Both are on by default (the wiring above) and shown as collapsible cards next to the LED bar.

- **LCD** follows `LCD_Manual.pdf`:
  - Busy flag with the manual's execution times: 40 µs per instruction or data access, and 1.64 ms for Clear/Home. Table 3.1 says 15.2 ms, which looks like a typo for 1.52 ms at 270 kHz.
  - Power-on reset: the module is busy for the first ~11.8 ms.
  - Instructions and data written while busy are **dropped**, as on the real module.
  - Address counter and data register read-back, including the stale-read behaviour.
  - DD RAM layout 00-27 and 40-67, with no RAM at 28-3F, so line 1 does not flow into line 2.
  - Display and cursor shift, CG RAM characters, 4-bit mode, and 1-line vs 2-line.
  - CG RAM is not cleared at power-on (the reset sequence only clears DD RAM). On the lab board it powers up with every row of character 4 = `0b01010`, so code `0x04`/`0x0C` shows two vertical bars until the program writes CG RAM.
  - E pulse width and the other §4.2.3 timings are not checked: the module does not complain about them.
  - Not modelled: BE (PA4), the 5x10 font, the tDDR data delay, and blink in simulated rather than wall-clock time.
- **Keypad** is a 4x4 matrix. Click a key to hold it, click again to release. A pressed key pulls its column low only while its row is driven low, so a program has to scan like it does on the real board.

## Open questions (also in docs/QUESTIONS.md)
1. Which Port D pin is the "TDX2" header label (motor sensor OpO)?
2. Physical LED bar order, bottom to top: is it PC0…PC7, PG0, PG1 (lab 2's assumption)?
