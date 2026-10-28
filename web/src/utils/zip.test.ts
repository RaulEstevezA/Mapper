import { describe, expect, it } from 'vitest'
import { crc32, createZip } from './zip.ts'

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('writes every file and a central directory that points at them', () => {
    const zip = createZip([
      { name: 'root.py', content: 'print(1)\n' },
      { name: 'dirección.py', content: 'x = "é"\n' },
    ])
    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    const end = zip.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(2)
    const centralStart = view.getUint32(end + 16, true)
    expect(view.getUint32(centralStart, true)).toBe(0x02014b50)
    expect(new TextDecoder().decode(zip.slice(30, 37))).toBe('root.py')
  })
})
