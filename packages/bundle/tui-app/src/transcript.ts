/**
 * The session-log → transcript projection: folds the agent's `session/event`
 * firehose into bounded display records and renders them as styled lines.
 * Purely presentational — nothing here reaches the model or the durable log.
 * @module @deepseek-ai/dsh-tui-app/transcript
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Style, StyledLine } from './render.ts'

/** Display record kinds; each maps to one style and line prefix. */
export type TranscriptKind = 'user' | 'assistant' | 'tool' | 'tool-result' | 'error' | 'info'

/** One bounded display record. */
export interface TranscriptEntry {
  /** The record kind. */
  kind: TranscriptKind
  /** The visible text. */
  text: string
}

/** Record kinds with their line style and prefix glyph. */
const KIND_STYLE: Readonly<Record<TranscriptKind, { style: Style; prefix: string }>> = {
  user: { style: 'bold', prefix: '› ' },
  assistant: { style: 'plain', prefix: '' },
  tool: { style: 'dim', prefix: '⧗ ' },
  'tool-result': { style: 'dim', prefix: '  ' },
  error: { style: 'red', prefix: '✗ ' },
  info: { style: 'dim', prefix: '· ' },
}

/** Maximum display records kept; the oldest drops first. */
const MAX_ENTRIES = 400
/** Maximum characters kept per record; longer text truncates with an ellipsis. */
const MAX_ENTRY_CHARS = 8000
/** Maximum characters of a tool call's raw arguments shown. */
const TOOL_ARGS_CHARS = 240

/** Bound one record's text. */
function bound(text: string): string {
  if (text.length <= MAX_ENTRY_CHARS) return text
  return text.slice(0, MAX_ENTRY_CHARS) + ' …'
}

/** Join message content blocks into display text: text passes through, others mark their type. */
function contentText(content: readonly { type: string; text?: string }[]): string {
  return content
    .map(block => block.type === 'text' ? block.text ?? '' : `[${block.type}]`)
    .join('')
}

/**
 * The transcript projection for one agent session.
 */
export class Transcript {
  private readonly entries: TranscriptEntry[] = []
  /** Pending tool calls by call id, remembering each call's tool name. */
  private readonly pending = new Map<string, string>()

  /**
   * The display records, oldest first.
   * @returns the bounded entry list.
   */
  view(): readonly TranscriptEntry[] {
    return this.entries
  }

  /**
   * Append one display record (interaction echoes, command results).
   * @param kind - the record kind.
   * @param text - the visible text.
   */
  push(kind: TranscriptKind, text: string): void {
    this.entries.push({ kind, text: bound(text) })
    if (this.entries.length > MAX_ENTRIES) this.entries.shift()
  }

  /**
   * Fold one session event into display records.
   * @param event - one committed session event.
   */
  consume(event: SessionEvent): void {
    switch (event.type) {
      case 'user/message': {
        const text = contentText(event.data.content)
        const kind: TranscriptKind = event.data.source.kind === 'user' ? 'user' : 'info'
        if (text !== '') this.push(kind, text)
        break
      }
      case 'assistant/message': {
        const text = contentText(event.data.message.content)
        if (text !== '') this.push('assistant', text)
        break
      }
      case 'tool/call': {
        this.pending.set(event.data.callId, event.data.name)
        const args = event.data.arguments
        const preview = args.length > TOOL_ARGS_CHARS ? args.slice(0, TOOL_ARGS_CHARS) + '…' : args
        this.push('tool', `${event.data.name} ${preview}`)
        break
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const name = this.pending.get(block?.toolCallId ?? '') ?? 'tool'
        if (block !== undefined) this.pending.delete(block.toolCallId)
        const bytes = block === undefined ? 0 : block.content.reduce(
          (total, part) => total + (part.type === 'text' ? String(part.text ?? '').length : 0), 0)
        const failed = event.data.error !== undefined || block?.isError === true
        const size = bytes === 0 ? '' : ` (${bytes} B)`
        this.push('tool-result', `${failed ? '✗' : '✓'} ${name}${size}`)
        break
      }
      case 'turn/end': {
        const reason = event.data.reason
        if (reason.kind === 'error') {
          this.push('error', `${reason.error.code}: ${reason.error.message}`)
        } else if (reason.kind === 'aborted') {
          this.push('info', 'interrupted')
        } else if (reason.kind === 'max-tokens') {
          this.push('info', 'the response reached its max-token limit')
        }
        break
      }
      default:
        // Everything else is presentation noise for the TUI (chunks, headers,
        // todos, command lifecycle, …).
        break
    }
  }

  /**
   * Render the records as styled, unwrapped lines.
   * @returns one styled line per record (multi-line records stay single records;
   * the renderer wraps them).
   */
  lines(): StyledLine[] {
    return this.entries.map(entry => {
      const { style, prefix } = KIND_STYLE[entry.kind]
      return { text: `${prefix}${entry.text}`, style }
    })
  }
}
