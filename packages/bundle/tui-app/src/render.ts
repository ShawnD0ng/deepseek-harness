/**
 * The TUI's deterministic frame renderer.
 *
 * `composeFrame` is a pure function from interface state to a fixed-height
 * {@link Frame}; `diffFrames` turns the difference between two frames into
 * one ANSI control-sequence string. Both are synchronous and free of wall
 * clock, terminal reads, or layout engines, so tests (and the PTY e2e)
 * reproduce exact bytes. Output is styled only when `color` is on
 * (the TUI respects the `NO_COLOR` convention).
 * @module @deepseek-ai/dsh-tui-app/render
 */

import { displayWidth } from './width.ts'

/** The text styles the TUI uses; `plain` emits no SGR codes. */
export type Style = 'plain' | 'dim' | 'bold' | 'red' | 'green' | 'yellow' | 'cyan' | 'magenta'

/** One styled transcript line before wrapping. */
export interface StyledLine {
  /** The line's visible text (no control sequences). */
  text: string
  /** The line's style; `plain` by default. */
  style?: Style
}

/** The single bottom status row. */
export interface StatusSpec {
  /** Left-aligned label (model identity or similar). */
  left: string
  /** Right-aligned label (turn state). */
  right: string
  /** Whether a turn is running — drives the spinner glyph. */
  busy: boolean
  /** Spinner frame, a render-count-derived integer indexing {@link SPINNER}. */
  spinner: number
}

/** The prompt input line. */
export interface InputSpec {
  /** The prompt glyphs printed left of the value. */
  prompt: string
  /** The current buffer text. */
  value: string
  /** Cursor position as a character index into `value`. */
  cursor: number
  /** Dimmed hint shown while the buffer is empty. */
  placeholder?: string
  /** An open slash-command completion popup above the input line. */
  completion?: CompletionSpec
}

/** A slash-command completion popup listing candidate command names. */
export interface CompletionSpec {
  /** Candidate command names without the leading slash, in display order. */
  options: readonly string[]
  /** Index of the highlighted candidate. */
  selected: number
}

/** An interactive multiple-choice question (ask-user). */
export interface QuestionSpec {
  /** The question text (also used as the heading). */
  title: string
  /** Optional detail rendered under the title. */
  detail?: string
  /** Selectable option labels. */
  options: readonly string[]
  /** Index of the highlighted option. */
  selected: number
  /** Toggled state per option for multi-select questions. */
  checked?: readonly boolean[]
}

/** An interactive allow/reject confirmation (approval). */
export interface ConfirmSpec {
  /** What is being decided. */
  message: string
  /** Optional why explanation. */
  detail?: string
  /** Choice labels in order. */
  choices: readonly string[]
  /** Index of the highlighted choice. */
  selected: number
}

/** Everything one frame renders. */
export interface FrameInput {
  /** The transcript, top to bottom (pre-wrapping). */
  body: StyledLine[]
  /** Lines scrolled up from the bottom of the body (0 follows the bottom). */
  bodyOffset: number
  /** The status row. */
  status: StatusSpec
  /** The input line, absent while a question or confirm owns the footer. */
  input?: InputSpec
  /** The active question widget, if any. */
  question?: QuestionSpec
  /** The active confirmation widget, if any. */
  confirm?: ConfirmSpec
  /** One transient notice row above the footer. */
  notice?: string
}

/** One terminal row of a composed frame. */
export interface FrameLine {
  /** The row's exact output text, including SGR sequences when colored. */
  text: string
}

/** A composed frame: exactly `height` rows plus the final cursor position. */
export interface Frame {
  /** One row per terminal row, in order. */
  lines: FrameLine[]
  /** The cursor's final position, 0-based row and column. */
  cursor: { row: number; col: number }
}

/** Braille spinner glyphs; the frame index advances per render while busy. */
export const SPINNER: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** SGR codes per style; `plain` and the color-off mode emit none. */
const SGR: Readonly<Record<Style, string>> = {
  plain: '',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

const RESET = '\x1b[0m'

/**
 * Wrap one style around `text` when color is on and the style is not plain.
 * @param text - the text to style.
 * @param style - the SGR style to apply, if any.
 * @param color - whether color output is enabled.
 * @returns the styled text, or `text` unchanged when color is off or no style applies.
 */
export function styled(text: string, style: Style | undefined, color: boolean): string {
  if (!color || style === undefined || style === 'plain') return text
  return SGR[style] + text + RESET
}

/**
 * Word-wrap `text` to `width` columns, breaking long words by character.
 * Hard newlines are preserved as line breaks.
 * @param text - the text to wrap.
 * @param width - the maximum line width in columns.
 * @returns the wrapped lines.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const lines: string[] = []
  for (const segment of text.split('\n')) {
    let current = ''
    let currentWidth = 0
    const push = (piece: string, pieceWidth: number): void => {
      if (current === '') {
        current = piece
        currentWidth = pieceWidth
        return
      }
      if (currentWidth + 1 + pieceWidth <= width) {
        current += ' ' + piece
        currentWidth += 1 + pieceWidth
        return
      }
      lines.push(current)
      current = piece
      currentWidth = pieceWidth
    }
    const pushLong = (piece: string): void => {
      // A single token wider than the line breaks by character.
      let rest = piece
      while (displayWidth(rest) > width) {
        let take = 0
        let takeWidth = 0
        for (const char of rest) {
          const charWidth = displayWidth(char)
          if (takeWidth + charWidth > width) break
          takeWidth += charWidth
          take += char.length
        }
        // A single character wider than the line still goes on its own line.
        if (take === 0) take = 1
        push(rest.slice(0, take), takeWidth)
        rest = rest.slice(take)
      }
      if (rest !== '') push(rest, displayWidth(rest))
    }
    for (const token of segment.split(' ')) {
      if (current === '' && displayWidth(token) > width) {
        pushLong(token)
        continue
      }
      if (displayWidth(token) > width) {
        lines.push(current)
        current = ''
        currentWidth = 0
        pushLong(token)
        continue
      }
      push(token, displayWidth(token))
    }
    // Every segment ends in a line: blank segments (hard newlines and
    // whitespace-only lines) stay visible as empty lines, and a segment with
    // tokens always leaves them in `current`.
    lines.push(current)
  }
  return lines
}

/** Truncate `text` so its display width is at most `width`. */
function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let result = ''
  for (const char of text) {
    if (displayWidth(result + char) > width) break
    result += char
  }
  return result
}

/** One wrapped body line with its style. */
function wrapStyled(line: StyledLine, width: number): StyledLine[] {
  return wrapText(line.text, width).map(text => ({ text, ...line.style !== undefined ? { style: line.style } : {} }))
}

/** Completion popup rows visible at once, excluding ellipsis rows. */
const POPUP_VISIBLE = 8

/**
 * Compose the completion popup rows above the input line.
 * @param completion - the open popup state, if any.
 * @param width - terminal width in columns.
 * @param color - whether SGR styling is emitted.
 * @returns the popup rows, top to bottom.
 */
function composeCompletion(completion: CompletionSpec | undefined, width: number, color: boolean): FrameLine[] {
  if (completion === undefined || completion.options.length === 0) return []
  const rows: FrameLine[] = []
  // The window slides only when the selection would leave the capped view,
  // so the highlighted row is always visible.
  const start = Math.max(0, Math.min(completion.selected, completion.options.length - POPUP_VISIBLE))
  if (start > 0) rows.push({ text: styled('…', 'dim', color) })
  completion.options.slice(start, start + POPUP_VISIBLE).forEach((name, index) => {
    const selected = start + index === completion.selected
    const raw = `${selected ? '› ' : '  '}/${name}`
    rows.push({ text: styled(truncateToWidth(raw, width), selected ? 'cyan' : 'plain', color) })
  })
  if (start + POPUP_VISIBLE < completion.options.length) rows.push({ text: styled('…', 'dim', color) })
  return rows
}

/**
 * Compose the question/confirm/input footer: rows with SGR codes embedded,
 * plus the input cursor position relative to the footer's top row.
 * @param input - the interface state.
 * @param width - terminal width in columns.
 * @param color - whether SGR styling is emitted.
 * @returns the footer rows and the cursor, when an input owns the footer.
 */
function composeFooter(input: FrameInput, width: number, color: boolean): { rows: FrameLine[]; cursor?: { row: number; col: number } } {
  const rows: FrameLine[] = []
  let cursor: { row: number; col: number } | undefined
  const question = input.question
  const confirm = input.confirm
  if (question !== undefined) {
    rows.push({ text: styled(question.title, 'bold', color) })
    if (question.detail !== undefined) rows.push({ text: styled(question.detail, 'dim', color) })
    question.options.forEach((option, index) => {
      const marker = index === question.selected ? '›' : (question.checked?.[index] === true ? '✓' : ' ')
      rows.push({
        text: `${styled(marker, 'cyan', color)} ${styled(option, index === question.selected ? 'cyan' : 'plain', color)}`,
      })
    })
  } else if (confirm !== undefined) {
    rows.push({ text: styled(confirm.message, 'bold', color) })
    if (confirm.detail !== undefined) rows.push({ text: styled(confirm.detail, 'dim', color) })
    const choices = confirm.choices.map((choice, index) => {
      const framed = index === confirm.selected ? `[${choice}]` : ` ${choice} `
      return styled(framed, index === confirm.selected ? 'cyan' : 'plain', color)
    }).join('  ')
    rows.push({ text: choices })
  } else if (input.input !== undefined) {
    const completionRows = composeCompletion(input.input.completion, width, color)
    rows.push(...completionRows)
    const prompt = styled(input.input.prompt, 'cyan', color)
    const promptWidth = displayWidth(input.input.prompt)
    const valueWidth = Math.max(1, width - promptWidth)
    const value = input.input.value
    if (value === '') {
      rows.push({ text: `${prompt}${styled(input.input.placeholder ?? '', 'dim', color)}` })
      cursor = { row: completionRows.length, col: promptWidth }
    } else {
      const valueLines = wrapText(value, valueWidth)
      valueLines.forEach((line, index) => {
        rows.push({ text: `${index === 0 ? prompt : ''}${line}` })
      })
      // Map the character-indexed cursor onto the wrapped rows.
      let consumed = 0
      let cursorRow = valueLines.length - 1
      for (let index = 0; index < valueLines.length; index++) {
        // The loop index always names an existing wrapped line.
        const lineChars = valueLines[index]!.length
        if (index < valueLines.length - 1 && consumed + lineChars <= input.input.cursor) {
          consumed += lineChars
          continue
        }
        cursorRow = index
        break
      }
      const cursorCol = displayWidth(value.slice(consumed, input.input.cursor))
      cursor = {
        row: completionRows.length + cursorRow,
        col: cursorRow === 0 ? promptWidth + cursorCol : cursorCol,
      }
    }
  }
  return cursor === undefined ? { rows } : { rows, cursor }
}

/** Compose the reverse-video status row. */
function composeStatus(status: StatusSpec, width: number, color: boolean): FrameLine {
  const glyph = status.busy
    // The index is a non-negative integer reduced modulo the array length.
    ? SPINNER[Math.abs(status.spinner) % SPINNER.length]!
    : '·'
  const left = truncateToWidth(`${glyph} ${status.left}`, width)
  // A non-empty right label keeps at least one separating column.
  const gap = status.right === '' ? 0 : 1
  const right = truncateToWidth(status.right, Math.max(0, width - displayWidth(left) - gap))
  const row = left + ' '.repeat(Math.max(gap, width - displayWidth(left) - displayWidth(right))) + right
  return { text: color ? `\x1b[7m${row}${RESET}` : row }
}

/** The wrapped body lines and the visible viewport, padded to `height` rows. */
function composeBody(input: FrameInput, width: number, height: number, color: boolean): FrameLine[] {
  const body = input.body.flatMap(line => wrapStyled(line, width))
  // bodyOffset counts lines scrolled up from the bottom; 0 follows the bottom.
  const offset = Math.max(0, body.length - height - input.bodyOffset)
  const viewport = body.slice(offset, offset + height)
  const rows: FrameLine[] = viewport.map(line => ({ text: styled(line.text, line.style, color) }))
  while (rows.length < height) rows.push({ text: '' })
  return rows
}

/**
 * Compose one frame from interface state.
 * @param input - the interface state.
 * @param width - terminal width in columns.
 * @param height - terminal height in rows.
 * @param color - whether SGR styling is emitted.
 * @returns the fixed-height frame and final cursor position.
 */
export function composeFrame(input: FrameInput, width: number, height: number, color: boolean): Frame {
  const safeWidth = Math.max(1, Math.floor(width))
  const safeHeight = Math.max(1, Math.floor(height))
  const footer = composeFooter(input, safeWidth, color)
  const notice = input.notice === undefined ? undefined : styled(input.notice, 'yellow', color)
  const noticeRows = notice === undefined ? [] : [{ text: notice }]
  // The status bar owns the last row; the footer sits directly above it.
  const bodyHeight = safeHeight - footer.rows.length - noticeRows.length - 1
  const footerStart = safeHeight - 1 - footer.rows.length
  const lines: FrameLine[] = []
  if (bodyHeight >= 0) {
    lines.push(...composeBody(input, safeWidth, bodyHeight, color), ...noticeRows, ...footer.rows)
  } else {
    // A shorter-than-footer terminal drops the body and notice first, then
    // the oldest footer rows. Both paths fill exactly safeHeight - 1 rows:
    // the normal path adds the body up to the boundary, and a footer longer
    // than the available rows keeps exactly that many.
    const available = safeHeight - 1
    lines.push(...footer.rows.slice(Math.max(0, footer.rows.length - available)))
  }
  lines.push(composeStatus(input.status, safeWidth, color))

  let cursor = { row: safeHeight - 1, col: 0 }
  if (footer.cursor !== undefined && footerStart >= 0) {
    cursor = {
      row: Math.min(footerStart + footer.cursor.row, safeHeight - 2),
      col: Math.min(footer.cursor.col, safeWidth),
    }
  }
  return { lines, cursor }
}

/**
 * Render the ANSI transition from `previous` to `next`.
 * @param previous - the last rendered frame, or undefined for the first paint.
 * @param next - the frame to show now.
 * @param color - whether SGR styling is emitted.
 * @returns the exact control-sequence string to write.
 */
export function diffFrames(previous: Frame | undefined, next: Frame, color: boolean): string {
  const writes: string[] = []
  for (let index = 0; index < next.lines.length; index++) {
    // The loop bound names an existing row.
    const line = next.lines[index]!
    if (previous?.lines[index]?.text !== line.text) {
      writes.push(`\x1b[${index + 1};1H${line.text}\x1b[K`)
    }
  }
  if (previous !== undefined) {
    for (let index = next.lines.length; index < previous.lines.length; index++) {
      writes.push(`\x1b[${index + 1};1H\x1b[K`)
    }
  }
  const row = Math.max(0, Math.min(next.cursor.row, next.lines.length - 1))
  const col = Math.max(0, next.cursor.col)
  writes.push(`\x1b[${row + 1};${col + 1}H`)
  return writes.join('') + (color ? RESET : '')
}
