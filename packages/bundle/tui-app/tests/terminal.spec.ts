/** Terminal driver seam: the real TTY driver over fake streams and the virtual terminal. */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTtyTerminal, NON_INTERACTIVE_MESSAGE, VirtualTerminal, type TtyInput, type TtyOutput } from '../src/terminal.ts'

/** A fake TTY input stream. */
class FakeInput extends EventEmitter implements TtyInput {
  isTTY = true
  rawMode: boolean | undefined
  paused = false
  setRawMode(mode: boolean): void { this.rawMode = mode }
  pause(): void { this.paused = true }
}

/** A fake TTY output stream. */
class FakeOutput extends EventEmitter implements TtyOutput {
  isTTY = true
  columns: number | undefined = 100
  rows: number | undefined = 30
  written = ''
  write(chunk: string): boolean { this.written += chunk; return true }
}

afterEach(() => {
  delete process.env.TERM
})

describe('createTtyTerminal', () => {
  it('fails loud when the streams are not TTYs', () => {
    const input = new FakeInput()
    input.isTTY = false
    const output = new FakeOutput()
    expect(() => createTtyTerminal(input, output)).toThrow(NON_INTERACTIVE_MESSAGE)
    expect(() => createTtyTerminal(input, output)).toThrow('dsh tui needs an interactive terminal')
  })

  it('fails loud for a dumb terminal', () => {
    process.env.TERM = 'dumb'
    expect(() => createTtyTerminal(new FakeInput(), new FakeOutput())).toThrow(NON_INTERACTIVE_MESSAGE)
  })

  it('enters raw and alternate mode, decodes keys, and restores idempotently', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const terminal = createTtyTerminal(input, output)
    expect(input.rawMode).toBe(true)
    expect(output.written).toContain('\x1b[?1049h\x1b[?25l')

    const keys: string[] = []
    terminal.onKey(key => { keys.push(key.kind) })
    input.emit('data', Buffer.from('ab', 'utf8'))
    input.emit('data', Buffer.from('\x1b[A', 'utf8'))
    expect(keys).toEqual(['char', 'char', 'up'])
    expect(terminal.width).toBe(100)
    expect(terminal.height).toBe(30)

    output.columns = 90
    const sizes: number[] = []
    terminal.onResize((width, height) => { sizes.push(width, height) })
    output.emit('resize')
    expect(sizes).toEqual([90, 30])

    const closed: number[] = []
    terminal.onClose(() => { closed.push(1) })
    input.emit('end')
    expect(closed).toEqual([1])

    terminal.restore()
    terminal.restore()
    expect(output.written).toContain('\x1b[?25h\x1b[1049l')
    expect(input.rawMode).toBe(false)
    expect(input.paused).toBe(true)
  })

  it('removes an unsubscribed key listener', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const terminal = createTtyTerminal(input, output)
    const keys: string[] = []
    const off = terminal.onKey(key => { keys.push(key.kind) })
    off()
    input.emit('data', Buffer.from('x', 'utf8'))
    expect(keys).toEqual([])
    terminal.restore()
  })

  it('defaults unknown stream sizes to 80×24', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    output.columns = undefined
    output.rows = undefined
    const terminal = createTtyTerminal(input, output)
    expect(terminal.width).toBe(80)
    expect(terminal.height).toBe(24)
    terminal.restore()
  })
})

describe('VirtualTerminal', () => {
  it('decodes keystrokes, collects output, and reports sizes', () => {
    const terminal = new VirtualTerminal({ width: 40, height: 12 })
    const keys: string[] = []
    terminal.onKey(key => { keys.push(key.kind) })
    terminal.feed('ab\r')
    expect(keys).toEqual(['char', 'char', 'enter'])
    terminal.write('frame')
    expect(terminal.output).toBe('frame')
    expect(terminal.width).toBe(40)
    expect(terminal.height).toBe(12)
    expect(terminal.restored).toBe(false)
    terminal.restore()
    expect(terminal.restored).toBe(true)
  })

  it('emits resize and close events and unsubscribes listeners', () => {
    const terminal = new VirtualTerminal()
    const sizes: number[] = []
    const offResize = terminal.onResize((width, height) => { sizes.push(width, height) })
    terminal.setSize(33, 7)
    expect(sizes).toEqual([33, 7])
    offResize()
    terminal.setSize(10, 3)
    expect(sizes).toEqual([33, 7])

    const closed: number[] = []
    const offClose = terminal.onClose(() => { closed.push(1) })
    terminal.close()
    expect(closed).toEqual([1])
    offClose()
    terminal.close()
    expect(closed).toEqual([1])

    const keys: string[] = []
    const offKey = terminal.onKey(key => { keys.push(key.kind) })
    offKey()
    terminal.feed('z')
    expect(keys).toEqual([])
  })

  it('defaults to an 80×24 size', () => {
    const terminal = new VirtualTerminal()
    expect(terminal.width).toBe(80)
    expect(terminal.height).toBe(24)
  })
})

describe('createTtyTerminal escape flush and disposers', () => {
  it('flushes a lone escape after the pending window', async () => {
    vi.useFakeTimers()
    try {
      const input = new FakeInput()
      const output = new FakeOutput()
      const terminal = createTtyTerminal(input, output)
      const keys: string[] = []
      terminal.onKey(key => { keys.push(key.kind) })
      input.emit('data', Buffer.from('\x1b', 'utf8'))
      expect(keys).toEqual([])
      vi.advanceTimersByTime(60)
      expect(keys).toEqual(['escape'])
      // A sequence that arrives before the window closes cancels the flush.
      input.emit('data', Buffer.from('\x1b', 'utf8'))
      input.emit('data', Buffer.from('[A', 'utf8'))
      vi.advanceTimersByTime(60)
      expect(keys).toEqual(['escape', 'up'])
      terminal.restore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a pending escape flush on restore', async () => {
    vi.useFakeTimers()
    try {
      const input = new FakeInput()
      const output = new FakeOutput()
      const terminal = createTtyTerminal(input, output)
      const keys: string[] = []
      terminal.onKey(key => { keys.push(key.kind) })
      input.emit('data', Buffer.from('\x1b', 'utf8'))
      terminal.restore()
      vi.advanceTimersByTime(60)
      expect(keys).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('tolerates repeated listener disposal and writes output', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const terminal = createTtyTerminal(input, output)
    const offKey = terminal.onKey(() => {})
    const offResize = terminal.onResize(() => {})
    const offClose = terminal.onClose(() => {})
    offKey(); offKey()
    offResize(); offResize()
    offClose(); offClose()
    terminal.write('hello')
    expect(output.written).toContain('hello')
    terminal.restore()
  })
})

describe('VirtualTerminal disposer idempotence', () => {
  it('tolerates repeated disposal of every listener type', () => {
    const terminal = new VirtualTerminal()
    const offKey = terminal.onKey(() => {})
    const offResize = terminal.onResize(() => {})
    const offClose = terminal.onClose(() => {})
    offKey(); offKey()
    offResize(); offResize()
    offClose(); offClose()
    const keys: string[] = []
    terminal.onKey(key => { keys.push(key.kind) })
    terminal.feed('q')
    expect(keys).toEqual(['char'])
  })
})
