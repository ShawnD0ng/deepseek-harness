/**
 * The session-log → transcript projection: folds the agent's `session/event`
 * firehose into bounded display records and renders them as styled lines.
 * Purely presentational — nothing here reaches the model or the durable log.
 * An optional {@link ToolPresenter} upgrades call/result records into the
 * tool-declared card views (diff cards render as colored lines).
 * @module @deepseek-ai/dsh-tui-app/transcript
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FileDiff, ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { Style, StyledLine } from './render.ts'

/** Display record kinds; each maps to one style and line prefix. */
export type TranscriptKind =
  | 'user' | 'assistant' | 'tool' | 'tool-result' | 'error' | 'info'
  | 'diff-path' | 'diff-remove' | 'diff-add'

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
  'diff-path': { style: 'dim', prefix: '  ' },
  'diff-remove': { style: 'red', prefix: '- ' },
  'diff-add': { style: 'green', prefix: '+ ' },
}

/** Maximum display records kept; the oldest drops first. */
const MAX_ENTRIES = 400
/** Maximum characters kept per record; longer text truncates with an ellipsis. */
const MAX_ENTRY_CHARS = 8000
/** Maximum characters of a tool call's raw arguments shown. */
const TOOL_ARGS_CHARS = 240
/** Maximum removed or added lines drawn per file diff; the rest collapse into one ellipsis line. */
const DIFF_SIDE_LINES = 10

/**
 * The presentation bridge the runner supplies: look up a tool's declared
 * call/result card. Either method may return `undefined` (no tool, no
 * presenter, or an unprojectable call), which keeps the generic rendering.
 */
export interface ToolPresenter {
  /**
   * Present one pending call's view.
   * @param name - the tool name.
   * @param args - the parsed call arguments.
   * @returns the declared view, if any.
   */
  presentCall(name: string, args: unknown): ToolCallView | undefined
  /**
   * Present one completed call's view.
   * @param name - the tool name.
   * @param args - the parsed call arguments.
   * @param result - the completed outcome.
   * @returns the declared view, if any.
   */
  presentResult(name: string, args: unknown, result: ToolResult): ToolResultView | undefined
}

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
 * Split a diff side's text into content lines. Empty text is zero lines and a
 * single trailing newline is a line terminator rather than an extra empty line,
 * mirroring the web diff card's terminator rule.
 * @param text - the removed or added side's text.
 * @returns the content lines.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * The transcript projection for one agent session.
 */
export class Transcript {
  private readonly entries: TranscriptEntry[] = []
  /** Pending tool calls by call id, remembering each call's name and parsed arguments. */
  private readonly pending = new Map<string, { name: string; args: unknown }>()
  private readonly presenter: ToolPresenter | undefined

  /**
   * @param presenter - optional bridge to the tools' declared call/result cards.
   */
  constructor(presenter?: ToolPresenter) {
    this.presenter = presenter
  }

  /**
   * The display records, oldest first.
   * @returns the bounded entry list.
   */
  view(): readonly TranscriptEntry[] {
    return this.entries
  }

  /**
   * Indices into {@link view} of user-prompt records, oldest first.
   * @returns the prompt record indices.
   */
  userIndices(): readonly number[] {
    const indices: number[] = []
    this.entries.forEach((entry, index) => {
      if (entry.kind === 'user') indices.push(index)
    })
    return indices
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
   * Append one file-diff card's rows: a path header per file (a same-file
   * continuation opens with an ellipsis gap), then the removed lines, then
   * the added lines, each side capped with an ellipsis continuation.
   * @param diffs - the changes to draw, in file order.
   */
  pushDiff(diffs: readonly FileDiff[]): void {
    let previousPath: string | undefined
    for (const diff of diffs) {
      this.push('diff-path', diff.path === previousPath ? '⋯' : diff.path)
      previousPath = diff.path
      if (diff.oldText !== null) {
        const removed = contentLines(diff.oldText)
        removed.slice(0, DIFF_SIDE_LINES).forEach(line => this.push('diff-remove', line))
        if (removed.length > DIFF_SIDE_LINES) this.push('diff-remove', '…')
      }
      const added = contentLines(diff.newText)
      added.slice(0, DIFF_SIDE_LINES).forEach(line => this.push('diff-add', line))
      if (added.length > DIFF_SIDE_LINES) this.push('diff-add', '…')
    }
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
        let args: unknown
        try {
          args = JSON.parse(event.data.arguments) as unknown
        } catch {
          args = undefined
        }
        this.pending.set(event.data.callId, { name: event.data.name, args })
        const view = this.presenter === undefined || args === undefined
          ? undefined
          : this.safePresentCall(event.data.name, args)
        if (view?.card === 'diff') {
          this.push('tool', view.title)
          this.pushDiff(view.diffs)
          break
        }
        const preview = event.data.arguments.length > TOOL_ARGS_CHARS
          ? event.data.arguments.slice(0, TOOL_ARGS_CHARS) + '…'
          : event.data.arguments
        this.push('tool', `${event.data.name} ${preview}`)
        break
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const call = this.pending.get(block?.toolCallId ?? '')
        const name = call?.name ?? 'tool'
        if (block !== undefined) this.pending.delete(block.toolCallId)
        const bytes = block === undefined ? 0 : block.content.reduce(
          (total, part) => total + (part.type === 'text' ? String(part.text ?? '').length : 0), 0)
        const failed = event.data.error !== undefined || block?.isError === true
        const size = bytes === 0 ? '' : ` (${bytes} B)`
        const view = this.presenter === undefined || call?.args === undefined || block === undefined
          ? undefined
          : this.safePresentResult(name, call.args, block.content, failed, event.data.meta)
        if (view?.card === 'diff') {
          this.push('tool-result', `${failed ? '✗' : '✓'} ${view.title ?? name}${size}`)
          this.pushDiff(view.diffs)
          break
        }
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

  /** Present one call without letting a projector error break the fold. */
  private safePresentCall(name: string, args: unknown): ToolCallView | undefined {
    try {
      return this.presenter!.presentCall(name, args)
    } catch {
      return undefined
    }
  }

  /** Present one completed call without letting a projector error break the fold. */
  private safePresentResult(
    name: string, args: unknown, content: readonly ContentBlock[], failed: boolean, meta: JsonValue | undefined,
  ): ToolResultView | undefined {
    try {
      return this.presenter!.presentResult(name, args, {
        content: [...content],
        isError: failed,
        ...meta === undefined ? {} : { meta },
      })
    } catch {
      return undefined
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
