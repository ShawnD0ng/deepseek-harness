/**
 * Incremental terminal keystroke decoding: an escape-sequence state machine
 * turning decoded stdin text into {@link Key} events.
 *
 * `parseKeys` returns a stateful parser; each `feed` call accepts one decoded
 * string chunk (a UTF-8 `StringDecoder` owns byte-boundary safety upstream)
 * and returns the keys completed by it. A chunk ending on a lone `ESC` stays
 * pending because the next chunk may continue a sequence; {@link KeyParser.flush}
 * resolves it into an escape key once the driver knows nothing follows.
 * Unrecognized sequences are dropped so a stray escape never leaks control
 * text into the input buffer. Bracketed paste (`ESC[200~` … `ESC[201~`) emits
 * its content as character keys with line breaks collapsed to spaces,
 * matching the TUI's single-line input. `ESC` before a printable character
 * emits that character with the `alt` modifier (the terminal's alt encoding),
 * and CSI arrow sequences carry their shift/alt/ctrl modifier bits.
 * @module @deepseek-ai/dsh-tui-app/keys
 */

/** Keyboard modifiers carried by arrow and alt-character keys. */
export type Modifier = 'shift' | 'alt' | 'ctrl'

/** One decoded keystroke. */
export type Key =
  | { readonly kind: 'char'; readonly char: string; readonly modifiers?: readonly Modifier[] }
  | { readonly kind: 'enter' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'up'; readonly modifiers?: readonly Modifier[] }
  | { readonly kind: 'down'; readonly modifiers?: readonly Modifier[] }
  | { readonly kind: 'left'; readonly modifiers?: readonly Modifier[] }
  | { readonly kind: 'right'; readonly modifiers?: readonly Modifier[] }
  | { readonly kind: 'home' }
  | { readonly kind: 'end' }
  | { readonly kind: 'page-up' }
  | { readonly kind: 'page-down' }
  | { readonly kind: 'ctrl'; readonly letter: string }

/** Parser state between chunks. */
type ParserState =
  | { readonly kind: 'ground' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'ss3' }
  | { readonly kind: 'csi'; readonly params: string }
  | { readonly kind: 'paste'; readonly text: string }
  | { readonly kind: 'paste-escape'; readonly text: string }
  | { readonly kind: 'paste-csi'; readonly params: string; readonly text: string }

/** CSI final bytes with no meaningful params (arrows, home, end). */
const CSI_FINAL: Readonly<Record<string, Key>> = {
  A: { kind: 'up' },
  B: { kind: 'down' },
  C: { kind: 'right' },
  D: { kind: 'left' },
  H: { kind: 'home' },
  F: { kind: 'end' },
}

/** SS3 (ESC O) final bytes. */
const SS3_FINAL: Readonly<Record<string, Key>> = {
  A: { kind: 'up' },
  B: { kind: 'down' },
  C: { kind: 'right' },
  D: { kind: 'left' },
  H: { kind: 'home' },
  F: { kind: 'end' },
}

/** `~`-terminated CSI params: the first number names the key; modifiers follow after `;`. */
const TILDE_KEYS: Readonly<Record<string, Key>> = {
  '1': { kind: 'home' },
  '3': { kind: 'delete' },
  '4': { kind: 'end' },
  '5': { kind: 'page-up' },
  '6': { kind: 'page-down' },
  '7': { kind: 'home' },
  '8': { kind: 'end' },
}

/** C0 byte to ctrl-key: `\x03` is ctrl-c, `\x15` is ctrl-u, and so on. */
function ctrlKey(code: number): Key | undefined {
  if (code >= 0x01 && code <= 0x1a) return { kind: 'ctrl', letter: String.fromCharCode(code + 0x60) }
  return undefined
}

/** xterm modifier parameter (the `N` of `1;N<final>`): 2 shift, 3 alt, 5 ctrl, summed bits combine. */
function csiModifiers(param: string): readonly Modifier[] {
  switch (param) {
    case '2': return ['shift']
    case '3': return ['alt']
    case '4': return ['shift', 'alt']
    case '5': return ['ctrl']
    case '6': return ['shift', 'ctrl']
    case '7': return ['alt', 'ctrl']
    case '8': return ['shift', 'alt', 'ctrl']
    default: return []
  }
}

/** Emit one paste buffer's characters (line breaks already normalized). */
function flushPaste(keys: Key[], text: string): void {
  for (const char of text) keys.push({ kind: 'char', char })
}

/** Feed one decoded chunk; the returned keys are exactly what this chunk completed. */
export interface KeyParser {
  /**
   * Decode one decoded text chunk into completed keys.
   * @param chunk - one decoded input chunk.
   * @returns the keys completed by this chunk, in order.
   */
  feed(chunk: string): Key[]
  /**
   * Whether a lone `ESC` is pending: the next chunk may still continue a
   * sequence, so the driver decides when nothing follows.
   * @returns true when a pending escape exists.
   */
  hasPendingEscape(): boolean
  /**
   * Resolve a pending lone `ESC` into an escape key.
   * @returns the escape key, or nothing when no escape is pending.
   */
  flush(): Key[]
}

/**
 * Create a stateful keystroke parser.
 * @returns the parser.
 */
export function parseKeys(): KeyParser {
  let state: ParserState = { kind: 'ground' }

  return {
    feed(chunk: string): Key[] {
      const keys: Key[] = []
      for (const char of chunk) {
        // for-of yields whole code points, so index 0 always resolves.
        const code = char.codePointAt(0)!
        switch (state.kind) {
          case 'ground':
            if (char === '\x1b') state = { kind: 'escape' }
            else if (char === '\r' || char === '\n') keys.push({ kind: 'enter' })
            else if (char === '\x7f' || char === '\b') keys.push({ kind: 'backspace' })
            else if (char === '\t') keys.push({ kind: 'tab' })
            else {
              const ctrl = ctrlKey(code)
              keys.push(ctrl ?? { kind: 'char', char })
            }
            break
          case 'escape':
            if (char === '[') state = { kind: 'csi', params: '' }
            else if (char === 'O') state = { kind: 'ss3' }
            else if (char === '\x1b') {
              // ESC ESC: one escape key, back at ground for the next byte.
              keys.push({ kind: 'escape' })
              state = { kind: 'ground' }
            } else if (char >= ' ' && char !== '\x7f') {
              // Alt+<printable> arrives as ESC followed by the character.
              keys.push({ kind: 'char', char, modifiers: ['alt'] })
              state = { kind: 'ground' }
            } else {
              // Not a tracked sequence: the whole pair is dropped.
              state = { kind: 'ground' }
            }
            break
          case 'ss3':
            state = { kind: 'ground' }
            if (SS3_FINAL[char] !== undefined) keys.push(SS3_FINAL[char])
            break
          case 'csi': {
            const params = state.params
            if (char >= '0' && char <= '9') {
              state = { kind: 'csi', params: params + char }
              break
            }
            if (char === ';') {
              state = { kind: 'csi', params: params + char }
              break
            }
            if (char === '?' && params === '') {
              state = { kind: 'csi', params: '?' }
              break
            }
            if (char === '~') {
              state = { kind: 'ground' }
              if (params === '200') {
                state = { kind: 'paste', text: '' }
              } else if (params !== '201') {
                // A `201~` without an open paste flushes nothing; any other
                // number names a function key. `split` always yields a head.
                const key = TILDE_KEYS[params.split(';')[0]!]
                if (key !== undefined) keys.push(key)
              }
              break
            }
            // Any other final byte: arrows and friends, bare or `1`-prefixed
            // (modified arrows carry `1;5`-style params).
            state = { kind: 'ground' }
            const final = CSI_FINAL[char]
            if (final !== undefined) {
              // `split` always yields a head; bare arrows carry empty params.
              const parts = params.split(';')
              const first = parts[0]!
              if (first === '' || first === '1') {
                const modifiers = parts.length > 1 ? csiModifiers(parts[1]!) : []
                if (final.kind === 'up' || final.kind === 'down' || final.kind === 'left' || final.kind === 'right') {
                  keys.push(modifiers.length > 0 ? { kind: final.kind, modifiers } : final)
                } else {
                  keys.push(final)
                }
              }
            }
            break
          }
          case 'paste':
            if (char === '\x1b') state = { kind: 'paste-escape', text: state.text }
            else if (char === '\r' || char === '\n') {
              // Collapse consecutive line breaks into one space.
              state = state.text.endsWith(' ')
                ? state
                : { kind: 'paste', text: state.text + ' ' }
            } else state = { kind: 'paste', text: state.text + char }
            break
          case 'paste-escape': {
            const text = state.text
            if (char === '[') state = { kind: 'paste-csi', params: '', text }
            else {
              // Aborted paste: flush what arrived and resume at ground.
              flushPaste(keys, text)
              state = { kind: 'ground' }
            }
            break
          }
          case 'paste-csi': {
            const text = state.text
            if (char >= '0' && char <= '9') {
              state = { kind: 'paste-csi', params: state.params + char, text }
              break
            }
            if (char === '~' && state.params === '201') {
              flushPaste(keys, text)
              state = { kind: 'ground' }
              break
            }
            // Not the paste terminator: keep the buffered text, drop the
            // interrupted sequence.
            flushPaste(keys, text)
            state = { kind: 'ground' }
            break
          }
        }
      }
      return keys
    },
    hasPendingEscape(): boolean {
      return state.kind === 'escape'
    },
    flush(): Key[] {
      if (state.kind !== 'escape') return []
      state = { kind: 'ground' }
      return [{ kind: 'escape' }]
    },
  }
}
