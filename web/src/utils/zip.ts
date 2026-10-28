/** Minimal .zip writer (stored, without compression) for downloading several generated files.
 * Source files are small text, so compressing them is not worth a dependency. */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function createZip(files: { name: string; content: string }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const entries = files.map((file) => ({ name: encoder.encode(file.name), data: encoder.encode(file.content) }))
  const localSize = entries.reduce((total, entry) => total + 30 + entry.name.length + entry.data.length, 0)
  const centralSize = entries.reduce((total, entry) => total + 46 + entry.name.length, 0)
  const output = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(output.buffer)
  let offset = 0
  let central = localSize
  // 1980-01-01 00:00, the earliest date a zip can hold: the content does not depend on when it was made
  const time = 0
  const date = (1 << 5) | 1

  for (const entry of entries) {
    const crc = crc32(entry.data)
    const header = offset
    // Local file header; flag 0x0800: names are UTF-8
    view.setUint32(offset, 0x04034b50, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 6, 0x0800, true)
    view.setUint16(offset + 8, 0, true)
    view.setUint16(offset + 10, time, true)
    view.setUint16(offset + 12, date, true)
    view.setUint32(offset + 14, crc, true)
    view.setUint32(offset + 18, entry.data.length, true)
    view.setUint32(offset + 22, entry.data.length, true)
    view.setUint16(offset + 26, entry.name.length, true)
    view.setUint16(offset + 28, 0, true)
    output.set(entry.name, offset + 30)
    output.set(entry.data, offset + 30 + entry.name.length)
    offset += 30 + entry.name.length + entry.data.length

    // Central directory entry
    view.setUint32(central, 0x02014b50, true)
    view.setUint16(central + 4, 20, true)
    view.setUint16(central + 6, 20, true)
    view.setUint16(central + 8, 0x0800, true)
    view.setUint16(central + 10, 0, true)
    view.setUint16(central + 12, time, true)
    view.setUint16(central + 14, date, true)
    view.setUint32(central + 16, crc, true)
    view.setUint32(central + 20, entry.data.length, true)
    view.setUint32(central + 24, entry.data.length, true)
    view.setUint16(central + 28, entry.name.length, true)
    view.setUint32(central + 42, header, true)
    output.set(entry.name, central + 46)
    central += 46 + entry.name.length
  }

  // End of central directory
  view.setUint32(central, 0x06054b50, true)
  view.setUint16(central + 8, entries.length, true)
  view.setUint16(central + 10, entries.length, true)
  view.setUint32(central + 12, centralSize, true)
  view.setUint32(central + 16, localSize, true)
  return output
}
