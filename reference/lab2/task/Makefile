SRC  ?= task2.asm
# `make flash path/file.hex` (or .asm) instead of SRC=...
ARG  := $(filter-out flash,$(MAKECMDGOALS))
ifneq ($(filter flash,$(MAKECMDGOALS)),)
ifneq ($(ARG),)
SRC  := $(firstword $(ARG))
endif
endif
INC  := /opt/homebrew/share/avra
PORT ?=

%.hex: %.asm
	avra -I $(INC) -fI $< -o $@

all: $(SRC:.asm=.hex)

flash: $(SRC:.asm=.hex)
	@p="$(PORT)"; [ -z "$$p" ] && [ -e .port ] && p=$$(cat .port) && [ ! -e "$$p" ] && p=""; \
	if [ -z "$$p" ]; then \
	  set -- /dev/cu.usbmodem* /dev/cu.usbserial*; \
	  ports=""; for x in "$$@"; do [ -e "$$x" ] && ports="$$ports $$x"; done; \
	  [ -n "$$ports" ] || { echo "No serial ports found"; exit 1; }; \
	  PS3="Port number: "; select p in $$ports; do break; done; \
	  echo "$$p" > .port; \
	fi; \
	avrdude -c wiring -p m2560 -P $$p -b 115200 -D -U flash:w:$<:i

forget:
	rm -f .port

clean:
	rm -f *.hex *.obj *.eep.hex *.cof
