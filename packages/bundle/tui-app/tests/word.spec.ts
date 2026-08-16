/** Deterministic word navigation. */

import { describe, expect, it } from 'vitest'
import { findWordBackward, findWordForward } from '../src/word.ts'

describe('findWordBackward', () => {
  it('moves over one word, skipping trailing whitespace', () => {
    expect(findWordBackward('alpha beta', 10)).toBe(6)
    expect(findWordBackward('alpha beta  ', 12)).toBe(6)
    expect(findWordBackward('alpha beta', 9)).toBe(6)
  })

  it('stops at punctuation runs as their own unit', () => {
    expect(findWordBackward('foo->bar', 7)).toBe(5)
    expect(findWordBackward('foo->bar', 5)).toBe(3)
    expect(findWordBackward('foo->bar', 3)).toBe(0)
  })

  it('clamps at the line start', () => {
    expect(findWordBackward('alpha', 0)).toBe(0)
    expect(findWordBackward('  alpha', 1)).toBe(0)
  })
})

describe('findWordForward', () => {
  it('moves over one word, skipping leading whitespace', () => {
    expect(findWordForward('alpha beta', 0)).toBe(5)
    expect(findWordForward('alpha beta', 5)).toBe(10)
    expect(findWordForward('alpha  beta', 5)).toBe(11)
  })

  it('stops at punctuation runs as their own unit', () => {
    expect(findWordForward('foo->bar', 0)).toBe(3)
    expect(findWordForward('foo->bar', 3)).toBe(5)
  })

  it('clamps at the line end', () => {
    expect(findWordForward('alpha', 5)).toBe(5)
    expect(findWordForward('alpha ', 4)).toBe(5)
  })
})
