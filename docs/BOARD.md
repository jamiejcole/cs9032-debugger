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
| LCD backlight (BL) | PE5 | (not simulated yet) |
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
| Audio Ain / ASD / MiO (unused) | PE3 / PG1 / PK10 | — |

The LED bar pins are the same set the lab 2 default uses. `ledBar` lists them from the
**bottom** LED up. The default puts PC0 at the bottom and PG1 at the top, which matches
lab 2's code ("upper 4 = PC6, PC7, PG0, PG1").

Full config for the board:

```json
{
  "ledBar": ["PC0","PC1","PC2","PC3","PC4","PC5","PC6","PC7","PG0","PG1"],
  "buttons": { "PB0": "PD0", "PB1": "PD1" },
  "lcd": { "data": "PORTF", "rs": "PA7", "rw": "PA5", "e": "PA6" },
  "keypad": { "rows": ["PL7","PL6","PL5","PL4"], "cols": ["PL3","PL2","PL1","PL0"] }
}
```

## Open questions (also in docs/QUESTIONS.md)
1. Which Port D pin is the "TDX2" header label (motor sensor OpO)?
2. Physical LED bar order, bottom to top: is it PC0…PC7, PG0, PG1 (lab 2's assumption)?
