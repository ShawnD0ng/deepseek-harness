/** Escape-sequence decoding into keystrokes. */

import { describe, expect, it } from 'vitest'
import { parseKeys, type KeyParser } from '../src/keys.ts'

describe('parseKeys', () => {
  function collect(chunks: readonly string[]): ReturnType<KeyParser['feed']> {
    const parser = parseKeys()
    return chunks.flatMap(chunk => parser.feed(chunk))
  }

  it('decodes plain characters and control keys', () => {
    expect(collect(['abc'])).toEqual([
      { kind: 'char', char: 'a' }, { kind: 'char', char: 'b' }, { kind: 'char', char: 'c' },
    ])
    expect(collect(['\r'])).toEqual([{ kind: 'enter' }])
    expect(collect(['\n'])).toEqual([{ kind: 'enter' }])
    expect(collect(['\x7f'])).toEqual([{ kind: 'backspace' }])
    expect(collect(['\b'])).toEqual([{ kind: 'backspace' }])
    expect(collect(['\t'])).toEqual([{ kind: 'tab' }])
  })

  it('maps C0 bytes to ctrl keys', () => {
    expect(collect(['\x03'])).toEqual([{ kind: 'ctrl', letter: 'c' }])
    expect(collect(['\x15'])).toEqual([{ kind: 'ctrl', letter: 'u' }])
    expect(collect(['\x17'])).toEqual([{ kind: 'ctrl', letter: 'w' }])
    expect(collect(['\x01'])).toEqual([{ kind: 'ctrl', letter: 'a' }])
    expect(collect(['\x05'])).toEqual([{ kind: 'ctrl', letter: 'e' }])
    expect(collect(['\x04'])).toEqual([{ kind: 'ctrl', letter: 'd' }])
    expect(collect(['\x0c'])).toEqual([{ kind: 'ctrl', letter: 'l' }])
  })

  it('decodes CSI arrow keys, split across chunks', () => {
    expect(collect(['\x1b[', 'A'])).toEqual([{ kind: 'up' }])
    expect(collect(['\x1b[B'])).toEqual([{ kind: 'down' }])
    expect(collect(['\x1b[C'])).toEqual([{ kind: 'right' }])
    expect(collect(['\x1b[D'])).toEqual([{ kind: 'left' }])
    expect(collect(['\x1b[H'])).toEqual([{ kind: 'home' }])
    expect(collect(['\x1b[F'])).toEqual([{ kind: 'end' }])
  })

  it('decodes modified arrows through their params', () => {
    expect(collect(['\x1b[1;5A'])).toEqual([{ kind: 'up', modifiers: ['ctrl'] }])
    expect(collect(['\x1b[1;5C'])).toEqual([{ kind: 'right', modifiers: ['ctrl'] }])
    expect(collect(['\x1b[1;6B'])).toEqual([{ kind: 'down', modifiers: ['shift', 'ctrl'] }])
    expect(collect(['\x1b[1;3D'])).toEqual([{ kind: 'left', modifiers: ['alt'] }])
    expect(collect(['\x1b[1;2A'])).toEqual([{ kind: 'up', modifiers: ['shift'] }])
    expect(collect(['\x1b[1;4A'])).toEqual([{ kind: 'up', modifiers: ['shift', 'alt'] }])
    expect(collect(['\x1b[1;7A'])).toEqual([{ kind: 'up', modifiers: ['alt', 'ctrl'] }])
    expect(collect(['\x1b[1;8A'])).toEqual([{ kind: 'up', modifiers: ['shift', 'alt', 'ctrl'] }])
    // An unknown modifier bit decodes as the plain key.
    expect(collect(['\x1b[1;9A'])).toEqual([{ kind: 'up' }])
  })

  it('decodes ESC before a printable character as an alt character', () => {
    expect(collect(['\x1bb'])).toEqual([{ kind: 'char', char: 'b', modifiers: ['alt'] }])
    expect(collect(['\x1b你'])).toEqual([{ kind: 'char', char: '你', modifiers: ['alt'] }])
  })

  it('decodes SS3 keys', () => {
    expect(collect(['\x1bOA'])).toEqual([{ kind: 'up' }])
    expect(collect(['\x1bOB'])).toEqual([{ kind: 'down' }])
    expect(collect(['\x1bOC'])).toEqual([{ kind: 'right' }])
    expect(collect(['\x1bOD'])).toEqual([{ kind: 'left' }])
  })

  it('decodes tilde keys', () => {
    expect(collect(['\x1b[3~'])).toEqual([{ kind: 'delete' }])
    expect(collect(['\x1b[5~'])).toEqual([{ kind: 'page-up' }])
    expect(collect(['\x1b[6~'])).toEqual([{ kind: 'page-down' }])
    expect(collect(['\x1b[1~'])).toEqual([{ kind: 'home' }])
    expect(collect(['\x1b[4~'])).toEqual([{ kind: 'end' }])
  })

  it('emits bracketed paste content as characters with line breaks collapsed', () => {
    expect(collect(['\x1b[200~line1\r\nline2\x1b[201~'])).toEqual(
      'line1 line2'.split('').map(char => ({ kind: 'char', char })),
    )
  })

  it('resolves a chunk-ending lone escape through flush', () => {
    const parser = parseKeys()
    expect(parser.feed('\x1b')).toEqual([])
    expect(parser.hasPendingEscape()).toBe(true)
    expect(parser.flush()).toEqual([{ kind: 'escape' }])
    expect(parser.hasPendingEscape()).toBe(false)
  })

  it('does not flush an escape that continues a sequence in the next chunk', () => {
    const parser = parseKeys()
    expect(parser.feed('\x1b[')).toEqual([])
    expect(parser.hasPendingEscape()).toBe(false)
    expect(parser.flush()).toEqual([])
    expect(parser.feed('A')).toEqual([{ kind: 'up' }])
  })

  it('flushes an aborted paste instead of dropping its content', () => {
    expect(collect(['\x1b[200~kept\x1bX'])).toEqual(
      'kept'.split('').map(char => ({ kind: 'char', char })),
    )
  })

  it('drops unrecognized sequences without leaking control text', () => {
    expect(collect(['\x1b[99~'])).toEqual([])
    // ESC before a control character is not an alt binding: the pair drops.
    expect(collect(['\x1b\r'])).toEqual([])
    expect(collect(['\x1bO9'])).toEqual([])
  })

  it('decodes a lone escape and escape-escape', () => {
    expect(collect(['\x1b'])).toEqual([]) // incomplete until the next byte decides
    expect(collect(['\x1b\x1b'])).toEqual([{ kind: 'escape' }])
  })

  it('decodes multibyte UTF-8 characters as single char keys', () => {
    expect(collect(['你', '😀'])).toEqual([
      { kind: 'char', char: '你' },
      { kind: 'char', char: '😀' },
    ])
  })
})

describe('parseKeys edge cases', () => {
  function collect(chunks: readonly string[]): ReturnType<KeyParser['feed']> {
    const parser = parseKeys()
    return chunks.flatMap(chunk => parser.feed(chunk))
  }

  it('drops a close bracket with no open paste', () => {
    expect(collect(['\x1b[201~'])).toEqual([])
  })

  it('decodes modified tilde keys through their params', () => {
    expect(collect(['\x1b[1;5~'])).toEqual([{ kind: 'home' }])
  })

  it('drops a question-prefixed CSI it does not track', () => {
    expect(collect(['\x1b[?25l'])).toEqual([])
  })

  it('flushes paste content when a non-tilde byte interrupts the terminator', () => {
    expect(collect(['\x1b[200~kept\x1b[20X'])).toEqual(
      'kept'.split('').map(char => ({ kind: 'char', char })),
    )
  })
})

describe('parseKeys dropped modified CSI', () => {
  function collect(chunks: readonly string[]): ReturnType<KeyParser['feed']> {
    const parser = parseKeys()
    return chunks.flatMap(chunk => parser.feed(chunk))
  }

  it('drops CSI finals with unrecognized params', () => {
    expect(collect(['\x1b[2A'])).toEqual([])
  })
})
