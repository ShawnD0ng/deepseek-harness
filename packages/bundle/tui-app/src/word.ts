/**
 * Deterministic word navigation for the input line.
 *
 * A navigation unit is one run of word characters (`A-Za-z0-9_`), or one run
 * of punctuation (any non-space, non-word characters). Whitespace is skipped
 * between units. The rule is locale-free and byte-stable so tests and the
 * PTY e2e compare exact cursor positions; non-Latin scripts navigate as one
 * punctuation-style run until the editor grows a real segmenter.
 * @module @deepseek-ai/dsh-tui-app/word
 */

const WORD_CHAR = /[A-Za-z0-9_]/

/**
 * The cursor after moving one word backward.
 * @param text - the input line.
 * @param cursor - the current character index.
 * @returns the new cursor, clamped to the line.
 */
export function findWordBackward(text: string, cursor: number): number {
  let position = Math.max(0, Math.min(cursor, text.length))
  while (position > 0 && text[position - 1] === ' ') position -= 1
  if (position === 0) return 0
  const word = WORD_CHAR.test(text[position - 1]!)
  while (position > 0 && text[position - 1] !== ' ' && WORD_CHAR.test(text[position - 1]!) === word) position -= 1
  return position
}

/**
 * The cursor after moving one word forward.
 * @param text - the input line.
 * @param cursor - the current character index.
 * @returns the new cursor, clamped to the line.
 */
export function findWordForward(text: string, cursor: number): number {
  let position = Math.max(0, Math.min(cursor, text.length))
  while (position < text.length && text[position] === ' ') position += 1
  if (position === text.length) return position
  const word = WORD_CHAR.test(text[position]!)
  while (position < text.length && text[position] !== ' ' && WORD_CHAR.test(text[position]!) === word) position += 1
  return position
}
