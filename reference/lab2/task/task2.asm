.include "m2560def.inc"

; Jamie Cole z5479353
; Lab 3 Task 2

; Reqs:
;   - Need to store/hold various amounts of text
;   - Control LED Bar based on number of words in current text
;   - Read pushbutton input to cycle thru each text

; Assumptions:
;  - Text is terminated by `ETX` (End of Text, 0x03)
;  - Words are separated by space char (0x20)
;  - Punctuation ignored
;  - Max word count limited by 4 bits (15)
;    - Text longer than 15? -> Flash LED bar until button pressed


; LED bar config 
;  - Upper 4 used for Word Count
;  - Lower 6 used for flashing
; LED Bar PC0-7 and PG0-1

.def on = r16
.def off = r17
.def button = r18
.def temp = r19
.def waitTime = r20
.def waitOuter = r21
.def waitMiddle = r22
.def wordCount = r23
.def byte = r24
.def textIndex = r25

init:
    ; Set up LED bar
    LDI on, 0xFF        ; bitmask for all output for port c
    LDI off, 0x00       ; bitmask for all output low
    out DDRC, on        ; set port c as output
    out PORTC, off      ; set output low

    LDI r18, 0x03       ; bitmask for bits 0-1
    out DDRG, r18       ; set bits 0-1 in port g as output
    out PORTG, off      ; set port g low

    ; Set up push buttons
    CBI DDRD, 1         ; set PB1 as input
    SBI PORTD, 1        ; set push button as input pullup
    CLR button

    CLR textIndex       ; set index to 0

main:
    ; check for button press AND RELEASE
    SBIC PIND, 1
    RJMP main           ; don't move to next instr. until button pushed

    LDI waitTime, 20    ; debounce for press down
    RCALL delay

waitForRelease:
    SBIS PIND, 1        ; wait for release
    RJMP waitForRelease

    LDI waitTime, 20    ; debounce for release
    RCALL delay

loadText:
    LDI ZL, low(textPointers << 1)
    LDI ZH, high(textPointers << 1)
    MOV temp, textIndex
    LSL temp            ; temp = index*2
    ADD ZL, temp        ; Z +=temp
    ADC ZH, off

    LPM temp, Z+
    LPM byte, Z
    MOV ZL, temp
    MOV ZH, byte

    RCALL countWords    ; count words in next text     
     
    INC textIndex
    CPI textIndex, 5
    BRNE doDisplay
    CLR textIndex

doDisplay:
    CPI wordCount, 16   ; if words are >= 16, flash the exception leds
    BRSH doFlash

    ; clear leds
    out PORTC, off
    out PORTG, off

    ; we want to use in this order, PC6, PC7, PG0, PG1
    SBRC wordCount, 0
    SBI PORTC, 6
    SBRC wordCount, 1
    SBI PORTC, 7
    SBRC wordCount, 2
    SBI PORTG, 0
    SBRC wordCount, 3
    SBI PORTG, 1

    RJMP main           ; leds displayed, go back to main

doFlash:
    out PORTC, off
    out PORTG, off

doFlashLoop:
    LDI temp, 0b00111111; only leds 0-5
    out PORTC, temp     ; turn on leds
    LDI waitTime, 200   ; init waitTime to 200ms
    rcall sleepy        ; delay
    CPI button, 1       ; CHECK IF BUTTON PRESSED DURING SLEEP
    BREQ stopFlash

    out PORTC, off      ; turn off leds
    LDI waitTime, 200
    rcall sleepy        ; delay
    CPI button, 1       ; CHECK IF BUTTON PRESSED DURING SLEEP
    BREQ stopFlash
    rjmp doFlashLoop    ; keep going

stopFlash:
    out PORTC, off      ; clear leds
    LDI waitTime, 20
    RCALL delay

flashDone:
    SBIS PIND, 1
    RJMP flashDone
    LDI waitTime, 20
    RCALL delay
    RJMP loadText


; ### helper functions ###
countWords:
    CLR wordCount
countLoop:
    LPM byte, Z+
    CPI byte, 0x03      ; ETX found? we r done
    BREQ countDone
    CPI byte, 0x20      ; space found -> inc word count
    BRNE countNext
    INC wordCount

countNext:
    RJMP countLoop
countDone:
    INC wordCount
    RET

; similar busy-wait loop as the delay func below but with a button press check in the loop
sleepy:
    CLR button
    outer:
        LDI waitOuter, 25
    middle:
        LDI waitMiddle, 212
    inner:
        DEC waitMiddle
        BRNE inner
        DEC waitOuter
        BRNE middle

        SBIS PIND, 1    ; skip jump if not pressed
        RJMP sleepyPressed

        DEC waitTime
        BRNE outer
        ret
    sleepyPressed:
        LDI button, 1
        ret

; busy-wait loop, uses waitTime register as number of ms 
delay:
    delayOuter:
        LDI waitOuter, 25
    delayMiddle:
        LDI waitMiddle, 212
    delayInner:
        DEC waitMiddle
        BRNE delayInner
        DEC waitOuter
        BRNE delayMiddle
        DEC waitTime
        BRNE delayOuter
        RET

end:
    rjmp end

.cseg 
textPointers: .dw text1 << 1, text2 << 1, text3 << 1, text4 << 1, text5 << 1
text1: .db "hello there this is a test string super cool stuff man", 0x03 ; 11 words
text2: .db "Why is there no MacOS version of Microchip Studio? Absolute insanity I tell you.", 0x03 ; 14 words
text3: .db "This sentence consists of a total combined length of fifteen words, can you believe it?", 0x03 ; 15 words
text4: .db "This sentence has sixteen words, which is in fact really only one more word than fifteen.", 0x03 ; 16 words
text5: .db "Hello Im just going to ramble on here for quite a while, as weve got to cover more than even sixteen words in this sentence, which is quite a lot to be honest. We currently have 37!", 0x03 ; 37 words
