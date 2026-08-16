/** Frame composition and ANSI diffing. */

import { describe, expect, it } from 'vitest'
import { composeFrame, diffFrames, wrapText, type FrameInput } from '../src/render.ts'

/** A minimal chat-state frame input. */
function frameInput(overrides: Partial<FrameInput> = {}): FrameInput {
  return {
    body: [],
    bodyOffset: 0,
    status: { left: 'p m', right: 'ready', busy: false, spinner: 0 },
    input: { prompt: '❯ ', value: '', cursor: 0, placeholder: 'hint' },
    ...overrides,
  }
}

/** A frame input whose footer comes from a question or confirm, not the input line. */
function withoutInput(overrides: Partial<FrameInput>): FrameInput {
  const input = frameInput(overrides)
  delete input.input
  return input
}

describe('wrapText', () => {
  it('wraps on word boundaries', () => {
    expect(wrapText('one two three', 7)).toEqual(['one two', 'three'])
  })

  it('breaks long words by character', () => {
    expect(wrapText('abcdef', 3)).toEqual(['abc', 'def'])
  })

  it('breaks wide characters by display width', () => {
    expect(wrapText('你你你', 4)).toEqual(['你你', '你'])
  })

  it('preserves hard newlines and empty lines', () => {
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b'])
  })

  it('returns the text unchanged when the width is not positive', () => {
    expect(wrapText('abc', 0)).toEqual(['abc'])
  })

  it('keeps a single over-wide character on its own line', () => {
    expect(wrapText('你', 1)).toEqual(['你'])
  })
})

describe('composeFrame', () => {
  it('lays out body, footer, and status rows at the given height', () => {
    const frame = composeFrame(frameInput(), 10, 6, false)
    expect(frame.lines).toHaveLength(6)
    // Footer row: prompt + dim placeholder (no color).
    expect(frame.lines[4]?.text).toBe('❯ hint')
    // Status row is last: left label, gap, truncated right label, pad.
    expect(frame.lines[5]?.text).toBe('· p m read')
    // Body rows are empty.
    expect(frame.lines[0]?.text).toBe('')
    expect(frame.cursor).toEqual({ row: 4, col: 2 })
  })

  it('wraps body content and scrolls the viewport from the bottom', () => {
    const frame = composeFrame(frameInput({
      body: [
        { text: 'alpha', style: 'plain' },
        { text: 'beta', style: 'dim' },
        { text: 'gamma', style: 'bold' },
      ],
    }), 10, 5, false)
    // Body viewport is 5 - 1 input - 1 status = 3 rows: all three fit.
    expect(frame.lines[0]?.text).toBe('alpha')
    expect(frame.lines[1]?.text).toBe('beta')
    expect(frame.lines[2]?.text).toBe('gamma')
    expect(frame.lines[3]?.text).toBe('❯ hint')
    expect(frame.cursor).toEqual({ row: 3, col: 2 })
  })

  it('applies bodyOffset as lines scrolled up from the bottom', () => {
    const body = [
      { text: 'alpha' }, { text: 'beta' }, { text: 'gamma' }, { text: 'delta' },
    ]
    // Four lines, three-row viewport: offset 0 follows the bottom.
    const bottom = composeFrame(frameInput({ body }), 10, 5, false)
    expect(bottom.lines[0]?.text).toBe('beta')
    expect(bottom.lines[1]?.text).toBe('gamma')
    expect(bottom.lines[2]?.text).toBe('delta')
    // Scrolling up one line reveals the line above the bottom view.
    const scrolled = composeFrame(frameInput({ body, bodyOffset: 1 }), 10, 5, false)
    expect(scrolled.lines[0]?.text).toBe('alpha')
    expect(scrolled.lines[1]?.text).toBe('beta')
    expect(scrolled.lines[2]?.text).toBe('gamma')
  })

  it('styles lines and the status bar when color is on', () => {
    const frame = composeFrame(frameInput({
      body: [{ text: 'dim line', style: 'dim' }],
    }), 10, 5, true)
    expect(frame.lines[0]?.text).toBe('\x1b[2mdim line\x1b[0m')
    expect(frame.lines[4]?.text).toMatch(/^\x1b\[7m/)
    expect(frame.lines[4]?.text).toMatch(/\x1b\[0m$/)
  })

  it('maps a wrapped input cursor to row and column', () => {
    const frame = composeFrame(frameInput({
      input: { prompt: '❯ ', value: 'abcdef', cursor: 4 },
    }), 5, 6, false)
    // Prompt takes 2 columns; the value wraps at 3 columns per row.
    expect(frame.lines[3]?.text).toBe('❯ abc')
    expect(frame.lines[4]?.text).toBe('def')
    expect(frame.cursor).toEqual({ row: 4, col: 1 })
  })

  it('renders a question widget above the status row', () => {
    const frame = composeFrame(withoutInput({
      question: { title: 'pick one', options: ['first', 'second'], selected: 1 },
    }), 12, 8, false)
    const lines = frame.lines.map(line => line.text)
    expect(lines).toContain('pick one')
    expect(lines).toContain('  first')
    expect(lines).toContain('› second')
    expect(lines[7]).toMatch(/ready/)
  })

  it('marks toggled multi-select options', () => {
    const frame = composeFrame(withoutInput({
      question: {
        title: 'pick any',
        options: ['first', 'second'],
        selected: 1,
        checked: [true, false],
      },
    }), 12, 8, false)
    const lines = frame.lines.map(line => line.text)
    expect(lines).toContain('✓ first')
    expect(lines).toContain('› second')
  })

  it('renders a confirmation widget with its choices', () => {
    const frame = composeFrame(withoutInput({
      confirm: { message: 'Allow bash?', choices: ['allow', 'reject'], selected: 0 },
    }), 20, 6, false)
    const lines = frame.lines.map(line => line.text)
    expect(lines).toContain('Allow bash?')
    expect(lines).toContain('[allow]   reject ')
  })

  it('drops body and notice rows first on a terminal shorter than the footer', () => {
    const frame = composeFrame(withoutInput({
      question: { title: 'q', options: ['a', 'b', 'c', 'd'], selected: 0 },
      notice: 'note',
      status: { left: 'p m', right: 'ok', busy: false, spinner: 0 },
    }), 10, 3, false)
    expect(frame.lines).toHaveLength(3)
    expect(frame.lines[0]?.text).toBe('  c')
    expect(frame.lines[1]?.text).toBe('  d')
    expect(frame.lines[2]?.text).toMatch(/ok/)
  })
})

describe('completion popup', () => {
  it('renders candidate rows above the input line with the highlighted marker', () => {
    const frame = composeFrame(frameInput({
      input: {
        prompt: '❯ ', value: '/', cursor: 1,
        completion: { options: ['compact', 'exit', 'goal'], selected: 1 },
      },
    }), 10, 10, false)
    const lines = frame.lines.map(line => line.text)
    expect(lines).toContain('  /compact')
    expect(lines).toContain('› /exit')
    expect(lines).toContain('  /goal')
    expect(lines).toContain('❯ /')
    // Three popup rows push the input cursor down by three rows.
    expect(frame.cursor).toEqual({ row: 8, col: 3 })
  })

  it('styles the highlighted row when color is on', () => {
    const frame = composeFrame(frameInput({
      input: {
        prompt: '❯ ', value: '/', cursor: 1,
        completion: { options: ['exit'], selected: 0 },
      },
    }), 10, 8, true)
    const lines = frame.lines.map(line => line.text)
    expect(lines).toContain('\x1b[36m› /exit\x1b[0m')
  })

  it('windows long candidate lists around the selection with ellipsis rows', () => {
    const options = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12']
    const top = composeFrame(frameInput({
      input: { prompt: '❯ ', value: '/', cursor: 1, completion: { options, selected: 0 } },
    }), 10, 14, false)
    const topLines = top.lines.map(line => line.text)
    expect(topLines).toContain('› /a1')
    expect(topLines).toContain('  /a8')
    expect(topLines).toContain('…')
    expect(topLines).not.toContain('  /a9')
    const bottom = composeFrame(frameInput({
      input: { prompt: '❯ ', value: '/', cursor: 1, completion: { options, selected: 11 } },
    }), 10, 14, false)
    const bottomLines = bottom.lines.map(line => line.text)
    expect(bottomLines).toContain('…')
    expect(bottomLines).toContain('  /a5')
    expect(bottomLines).toContain('› /a12')
    expect(bottomLines).not.toContain('  /a4')
  })

  it('truncates candidate rows to the terminal width', () => {
    const frame = composeFrame(frameInput({
      input: {
        prompt: '❯ ', value: '/', cursor: 1,
        completion: { options: ['compact'], selected: 0 },
      },
    }), 8, 10, false)
    // Footer start: 10 - 1 status - 2 footer rows = 7.
    expect(frame.lines[7]?.text).toBe('› /compa')
  })

  it('renders no popup rows for an empty candidate list', () => {
    const frame = composeFrame(frameInput({
      input: {
        prompt: '❯ ', value: '/', cursor: 1,
        completion: { options: [], selected: 0 },
      },
    }), 10, 6, false)
    expect(frame.lines[4]?.text).toBe('❯ /')
    expect(frame.cursor).toEqual({ row: 4, col: 3 })
  })
})

describe('diffFrames', () => {
  it('paints every row and positions the cursor on the first frame', () => {
    const frame = composeFrame(frameInput(), 10, 4, false)
    expect(diffFrames(undefined, frame, false)).toBe(
      '\x1b[1;1H\x1b[K\x1b[2;1H\x1b[K\x1b[3;1H❯ hint\x1b[K'
      + '\x1b[4;1H· p m read\x1b[K\x1b[3;3H',
    )
  })

  it('rewrites only changed rows', () => {
    const before = composeFrame(frameInput(), 10, 4, false)
    const after = composeFrame(frameInput({
      input: { prompt: '❯ ', value: 'x', cursor: 1 },
    }), 10, 4, false)
    const out = diffFrames(before, after, false)
    expect(out).toContain('\x1b[3;1H❯ x\x1b[K')
    expect(out).not.toContain('\x1b[1;1H')
    expect(out).not.toContain('\x1b[2;1H')
    expect(out.endsWith('\x1b[3;4H')).toBe(true)
  })

  it('erases rows that disappear from the previous frame', () => {
    const before = composeFrame(frameInput(), 10, 5, false)
    const after = composeFrame(frameInput(), 10, 4, false)
    const out = diffFrames(before, after, false)
    expect(out).toContain('\x1b[5;1H\x1b[K')
  })

  it('appends a style reset when color is on', () => {
    const frame = composeFrame(frameInput(), 10, 4, true)
    expect(diffFrames(undefined, frame, true).endsWith('\x1b[0m')).toBe(true)
  })
})

describe('render edge cases', () => {
  it('breaks a long token that follows text on the current line', () => {
    expect(wrapText('a bbbbb', 3)).toEqual(['a', 'bbb', 'bb'])
  })

  it('keeps whitespace-only segments as blank lines', () => {
    expect(wrapText('   ', 10)).toEqual([''])
  })

  it('renders an input without a placeholder', () => {
    const frame = composeFrame(frameInput({
      input: { prompt: '❯ ', value: '', cursor: 0 },
    }), 10, 4, false)
    expect(frame.lines[2]?.text).toBe('❯ ')
  })

  it('omits the status gap when the right label is empty', () => {
    const frame = composeFrame(frameInput({
      status: { left: 'x', right: '', busy: false, spinner: 0 },
    }), 6, 4, false)
    expect(frame.lines[3]?.text).toBe('· x   ')
  })


})

describe('render footerless frames', () => {
  it('composes a frame with no footer widgets', () => {
    const bare = frameInput()
    delete bare.input
    const frame = composeFrame(bare, 10, 4, false)
    expect(frame.lines).toHaveLength(4)
    expect(frame.lines[0]?.text).toBe('')
    // The 10-column status row truncates "ready" to "read".
    expect(frame.lines[3]?.text).toMatch(/read/)
    expect(frame.cursor).toEqual({ row: 3, col: 0 })
  })
})
