.include "m2560def.inc"

; Jamie Cole z5479353
; Lab 3 practice stuff

; Setting the LED bar first 3 bars to on
; first 3 bars are on port PC0, PC1 and PC2.
; To set GPIO we must set all 3 registers. DDxx, PORTxn, PINxn.

SBI DDRC, 0
SBI PORTC, 0
SBI DDRC, 1
SBI PORTC, 1
SBI DDRC, 2
SBI PORTC, 2

