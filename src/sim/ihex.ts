/** Parse Intel HEX (types 00, 01, 02, 04) into `target`. Throws on bad checksum. */
export function loadIhex(text: string, target: Uint8Array): void {
  let base = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error(`ihex: bad line "${line}"`);
    const bytes = Buffer.from(line.slice(1), 'hex');
    const sum = bytes.reduce((a, b) => a + b, 0) & 0xff;
    if (sum !== 0) throw new Error(`ihex: checksum error in "${line}"`);
    const len = bytes[0], addr = (bytes[1] << 8) | bytes[2], type = bytes[3];
    const data = bytes.subarray(4, 4 + len);
    if (type === 0x00) target.set(data, base + addr);
    else if (type === 0x01) return;
    else if (type === 0x02) base = ((data[0] << 8) | data[1]) << 4;
    else if (type === 0x04) base = ((data[0] << 8) | data[1]) << 16;
  }
}
