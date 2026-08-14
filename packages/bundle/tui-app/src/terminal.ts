/**
 * The terminal driver seam: raw-mode/alternate-screen management over the
 * process TTY, with a deterministic {@link VirtualTerminal} for tests.
 *
 * `createTtyTerminal` is the production driver; it fails loud when the
 * process has no interactive terminal. The TUI plugin obtains its driver
 * through `internals.createTerminal` so tests substitute the virtual one
 * without touching the real TTY.
 * @module @deepseek-ai/dsh-tui-app/terminal
 */

import { StringDecoder } from 'node:string_decoder'
import { parseKeys, type Key } from './keys.ts'

/** Minimal stdin face: the TTY facts and events the driver uses. */
export interface TtyInput {
  /** Whether this stream is a terminal. */
  readonly isTTY?: boolean
  /** Enable/disable raw mode (a TTY feature). */
  setRawMode?(mode: boolean): void
  /** Stop the flowing read that the key listener started. */
  pause?(): void
  /** Subscribe to input data and stream end. */
  on(event: 'data' | 'end', listener: (chunk: Buffer) => void): unknown
  /** Unsubscribe. */
  removeListener(event: 'data' | 'end', listener: (chunk: Buffer) => void): unknown
}

/** Minimal stdout face: the TTY facts and writes the driver uses. */
export interface TtyOutput {
  /** Whether this stream is a terminal. */
  readonly isTTY?: boolean
  /** Terminal width in columns; absent or undefined until the TTY reports it. */
  readonly columns?: number | undefined
  /** Terminal height in rows; absent or undefined until the TTY reports it. */
  readonly rows?: number | undefined
  /** Write output bytes. */
  write(chunk: string): unknown
  /** Subscribe to terminal size changes. */
  on(event: 'resize', listener: () => void): unknown
  /** Unsubscribe. */
  removeListener(event: 'resize', listener: () => void): unknown
}

/** A terminal the TUI can drive: keys in, frames out, with size events. */
export interface TerminalDriver {
  /** Terminal width in columns. */
  readonly width: number
  /** Terminal height in rows. */
  readonly height: number
  /**
   * Subscribe to decoded keystrokes.
   * @param listener - the keystroke handler.
   * @returns the disposer.
   */
  onKey(listener: (key: Key) => void): () => void
  /**
   * Subscribe to size changes.
   * @param listener - the size handler.
   * @returns the disposer.
   */
  onResize(listener: (width: number, height: number) => void): () => void
  /**
   * Subscribe to input close (stdin end).
   * @param listener - the close handler.
   * @returns the disposer.
   */
  onClose(listener: () => void): () => void
  /**
   * Write output bytes.
   * @param chunk - the frame bytes.
   */
  write(chunk: string): void
  /**
   * Leave raw/alternate mode and restore the terminal; idempotent.
   */
  restore(): void
}

/** The failure message when the process has no interactive terminal. */
export const NON_INTERACTIVE_MESSAGE = 'dsh tui needs an interactive terminal; use "dsh --profile headless <task>" for pipes and scripts'

/**
 * Create the production driver over the process TTY, or throw
 * {@link NON_INTERACTIVE_MESSAGE} when stdin/stdout are not a terminal
 * (a `TERM=dumb` terminal counts as not interactive).
 * @param stdin - the process input stream.
 * @param stdout - the process output stream.
 * @returns the live terminal driver.
 */
export function createTtyTerminal(stdin: TtyInput, stdout: TtyOutput): TerminalDriver {
  if (stdin.isTTY !== true || stdout.isTTY !== true || process.env.TERM === 'dumb') {
    throw new Error(NON_INTERACTIVE_MESSAGE)
  }
  const parser = parseKeys()
  const decoder = new StringDecoder('utf8')
  const keyListeners: ((key: Key) => void)[] = []
  const resizeListeners: ((width: number, height: number) => void)[] = []
  const closeListeners: (() => void)[] = []
  let restored = false

  /** Emit decoded keys to every listener. */
  const emit = (keys: readonly Key[]): void => {
    for (const key of keys) {
      for (const listener of keyListeners) listener(key)
    }
  }

  // A lone ESC stays pending in the parser until the next chunk proves it is
  // not a sequence prefix; a real escape key therefore arrives as one read.
  let escapeTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleEscapeFlush = (): void => {
    if (escapeTimer !== undefined) clearTimeout(escapeTimer)
    if (parser.hasPendingEscape()) {
      escapeTimer = setTimeout(() => { emit(parser.flush()) }, 50)
    }
  }

  const onData = (chunk: Buffer): void => {
    emit(parser.feed(decoder.write(chunk)))
    scheduleEscapeFlush()
  }
  const onEnd = (): void => {
    for (const listener of closeListeners) listener()
  }
  const onResize = (): void => {
    for (const listener of resizeListeners) listener(size().width, size().height)
  }
  const size = (): { width: number; height: number } => ({
    width: Math.max(1, stdout.columns ?? 80),
    height: Math.max(1, stdout.rows ?? 24),
  })

  stdin.setRawMode?.(true)
  stdin.on('data', onData)
  stdin.on('end', onEnd)
  stdout.on('resize', onResize)
  stdout.write('\x1b[?1049h\x1b[?25l')

  return {
    get width(): number { return size().width },
    get height(): number { return size().height },
    onKey(listener) {
      keyListeners.push(listener)
      return () => {
        const index = keyListeners.indexOf(listener)
        if (index >= 0) keyListeners.splice(index, 1)
      }
    },
    onResize(listener) {
      resizeListeners.push(listener)
      return () => {
        const index = resizeListeners.indexOf(listener)
        if (index >= 0) resizeListeners.splice(index, 1)
      }
    },
    onClose(listener) {
      closeListeners.push(listener)
      return () => {
        const index = closeListeners.indexOf(listener)
        if (index >= 0) closeListeners.splice(index, 1)
      }
    },
    write(chunk: string): void {
      stdout.write(chunk)
    },
    restore(): void {
      if (restored) return
      restored = true
      if (escapeTimer !== undefined) clearTimeout(escapeTimer)
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      stdout.removeListener('resize', onResize)
      stdout.write('\x1b[?25h\x1b[1049l')
      stdin.setRawMode?.(false)
      // Removing the data listener alone leaves the stream flowing, whose
      // pending read keeps the event loop alive after the tree drains.
      stdin.pause?.()
    },
  }
}

/**
 * A deterministic in-memory terminal for tests: `feed` injects keystrokes,
 * `write` accumulates output, and sizes change explicitly.
 */
export class VirtualTerminal implements TerminalDriver {
  private readonly parser = parseKeys()
  private readonly keyListeners: ((key: Key) => void)[] = []
  private readonly resizeListeners: ((width: number, height: number) => void)[] = []
  private readonly closeListeners: (() => void)[] = []
  private sizeValue: { width: number; height: number }
  /** Every byte written to the terminal, in order. */
  output = ''
  /** Whether {@link restore} ran. */
  restored = false

  /**
   * Create a virtual terminal.
   * @param options - initial size; defaults to 80×24.
   */
  constructor(options: { width?: number; height?: number } = {}) {
    this.sizeValue = { width: options.width ?? 80, height: options.height ?? 24 }
  }

  get width(): number { return this.sizeValue.width }

  get height(): number { return this.sizeValue.height }

  /**
   * Inject one decoded input chunk as keystrokes; a trailing lone ESC flushes as escape.
   * @param chunk - one decoded input sequence (a key press, escape sequence, or paste payload).
   */
  feed(chunk: string): void {
    for (const key of [...this.parser.feed(chunk), ...this.parser.flush()]) {
      for (const listener of this.keyListeners) listener(key)
    }
  }

  /**
   * Change the size and emit the resize event.
   * @param width - new column count.
   * @param height - new row count.
   */
  setSize(width: number, height: number): void {
    this.sizeValue = { width, height }
    for (const listener of this.resizeListeners) listener(width, height)
  }

  /** Emit the input-close event. */
  close(): void {
    for (const listener of this.closeListeners) listener()
  }

  onKey(listener: (key: Key) => void): () => void {
    this.keyListeners.push(listener)
    return () => {
      const index = this.keyListeners.indexOf(listener)
      if (index >= 0) this.keyListeners.splice(index, 1)
    }
  }

  onResize(listener: (width: number, height: number) => void): () => void {
    this.resizeListeners.push(listener)
    return () => {
      const index = this.resizeListeners.indexOf(listener)
      if (index >= 0) this.resizeListeners.splice(index, 1)
    }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.push(listener)
    return () => {
      const index = this.closeListeners.indexOf(listener)
      if (index >= 0) this.closeListeners.splice(index, 1)
    }
  }

  write(chunk: string): void {
    this.output += chunk
  }

  restore(): void {
    this.restored = true
  }
}
