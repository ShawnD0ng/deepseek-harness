/** Display-width arithmetic over the wcwidth range tables. */

import { describe, expect, it } from 'vitest'
import { displayWidth } from '../src/width.ts'

describe('displayWidth', () => {
  it('counts ASCII characters as one column', () => {
    expect(displayWidth('hello world')).toBe(11)
    expect(displayWidth('')).toBe(0)
    expect(displayWidth('a1!@#')).toBe(5)
  })

  it('counts East Asian Wide characters as two columns', () => {
    expect(displayWidth('你好')).toBe(4)
    expect(displayWidth('日本語')).toBe(6)
    expect(displayWidth('한국어')).toBe(6)
    expect(displayWidth('漢字')).toBe(4)
  })

  it('counts fullwidth forms as two columns', () => {
    expect(displayWidth('ＡＢＣ')).toBe(6)
    expect(displayWidth('，。！')).toBe(6)
  })

  it('counts common emoji as two columns', () => {
    expect(displayWidth('🚀')).toBe(2)
    expect(displayWidth('✓')).toBe(1)
    expect(displayWidth('⧗')).toBe(1)
    expect(displayWidth('❯')).toBe(1)
    expect(displayWidth('📦📦')).toBe(4)
  })

  it('ignores control characters and zero-width format characters', () => {
    // The renderer never measures SGR-embedded strings; raw measurement
    // counts only the printable bytes of an escape sequence as columns.
    expect(displayWidth('\x1b')).toBe(0)
    expect(displayWidth('\x1b[31mred\x1b[0m')).toBe(10)
    expect(displayWidth('\u200d\u200b')).toBe(0)
    expect(displayWidth('\t\n\r')).toBe(0)
  })

  it('treats combining marks as zero columns', () => {
    // e + combining acute accent = one column.
    expect(displayWidth('e\u0301')).toBe(1)
    // CJK + variation selector still two columns.
    expect(displayWidth('\u56fd\ufe0f')).toBe(2)
  })

  it('mixes scripts and widths', () => {
    expect(displayWidth('ab你好🚀c')).toBe(2 + 4 + 2 + 1)
  })
})
