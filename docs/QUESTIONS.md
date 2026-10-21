# Open questions

1. **Brief path mismatch:** the brief says `reference/lab2/task2.obj`; files are in
   `reference/lab2/task/`. Tests use the real path.
2. **Floating inputs** read as 0 on PINx (Microchip Studio's behaviour). A real floating pin is
   undefined. OK?
3. **Board wiring:** done in `docs/BOARD.md` from the student's corrected table.
4. **Motor sensor pin:** "TDX2" on the Port D header. Which PDn? (PB0 = PD0 "RDX4" and
   PB1 = PD1 "RDX3" are confirmed.)
5. **LED bar orientation:** is bottom-to-top PC0…PC7, PG0, PG1? The PDF's PG2/PG3 wiring is
   wrong (student-confirmed). The correct LED0/LED1 = PG0/PG1.
