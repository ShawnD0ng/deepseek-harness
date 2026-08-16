/**
 * Slash-command completion for the input line.
 *
 * Completion operates only while the buffer is a pure command prefix —
 * it starts with `/` and holds no space — because the popup completes
 * exactly one command name, the line's first token. A buffer with
 * arguments already names its command.
 * @module @deepseek-ai/dsh-tui-app/complete
 */

/**
 * Filter the runtime's command names by the buffer's command prefix.
 * @param names - available command names without the leading slash.
 * @param buffer - the current input line.
 * @returns the matching names in `names` order, or nothing when the buffer is not a pure command prefix.
 */
export function commandCandidates(names: readonly string[], buffer: string): readonly string[] {
  if (!buffer.startsWith('/') || buffer.includes(' ')) return []
  const prefix = buffer.slice(1)
  return names.filter(name => name.startsWith(prefix))
}

/**
 * Build the completed line for one accepted command name.
 * @param name - the accepted command name without the leading slash.
 * @returns the completed line and the cursor at its end.
 */
export function completedCommand(name: string): { value: string; cursor: number } {
  const value = `/${name}`
  return { value, cursor: value.length }
}
