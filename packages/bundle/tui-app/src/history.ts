/**
 * Prompt history: an in-memory ring of submitted prompts with emacs-style
 * navigation. Not persisted — a fresh process starts empty (documented in the
 * package README).
 * @module @deepseek-ai/dsh-tui-app/history
 */

/** Maximum remembered prompts; the oldest drops first. */
const MAX_ENTRIES = 100

/**
 * Submitted-prompt history with a live-editing slot.
 * @param entries - optional seed entries, oldest first (tests).
 */
export class PromptHistory {
  private readonly entries: string[] = []
  /** The buffer saved when navigation left the live-editing slot. */
  private draft = ''
  /** 0 edits live; N > 0 reads the Nth newest entry. */
  private position = 0

  constructor(seed: readonly string[] = []) {
    for (const entry of seed) this.push(entry)
  }

  /**
   * Record one submitted prompt; a repeat of the newest entry is ignored.
   * @param text - the submitted prompt text.
   */
  push(text: string): void {
    // A resubmission still returns to live editing: the duplicate guard only
    // keeps the entry list free of consecutive repeats.
    this.position = 0
    this.draft = ''
    if (this.entries[this.entries.length - 1] === text) return
    this.entries.push(text)
    if (this.entries.length > MAX_ENTRIES) this.entries.shift()
  }

  /**
   * Navigate one step: positive goes older, negative newer.
   * @param direction - +1 older, -1 newer.
   * @param current - the live buffer, saved when navigation starts.
   * @returns the buffer to show at the new position.
   */
  navigate(direction: 1 | -1, current: string): string {
    if (direction === 1) {
      if (this.position === 0) this.draft = current
      if (this.position < this.entries.length) {
        this.position += 1
        // A positive position always names an existing entry.
        return this.entries[this.entries.length - this.position]!
      }
      return current
    }
    if (this.position === 0) return current
    this.position -= 1
    if (this.position === 0) return this.draft
    // A positive position always names an existing entry.
    return this.entries[this.entries.length - this.position]!
  }
}
