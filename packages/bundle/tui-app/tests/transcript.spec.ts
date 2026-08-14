/** Session-log → transcript folding. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Transcript } from '../src/transcript.ts'

/** One crafted session event for the projection. */
function event<T extends SessionEvent['type']>(type: T, data: unknown): SessionEvent {
  return { type, seq: 0, time: 0, data } as SessionEvent
}

describe('Transcript', () => {
  it('projects human prompts as user records and plugin injections as info', () => {
    const transcript = new Transcript()
    transcript.consume(event('user/message', {
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }))
    transcript.consume(event('user/message', {
      content: [{ type: 'text', text: 'context note' }],
      source: { kind: 'plugin', plugin: 'x' },
    }))
    expect(transcript.view()).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'info', text: 'context note' },
    ])
  })

  it('marks non-text content blocks', () => {
    const transcript = new Transcript()
    transcript.consume(event('assistant/message', {
      turn: 0,
      step: 1,
      message: {
        role: 'assistant',
        id: 'm',
        content: [
          { type: 'text', text: 'see ' },
          { type: 'image', attachmentId: 'img-1' },
        ],
        source: { provider: 'p', model: 'm' },
      },
    }))
    expect(transcript.view()).toEqual([{ kind: 'assistant', text: 'see [image]' }])
  })

  it('ignores empty assistant messages', () => {
    const transcript = new Transcript()
    transcript.consume(event('assistant/message', {
      turn: 0,
      step: 1,
      message: {
        role: 'assistant',
        id: 'm',
        content: [],
        source: { provider: 'p', model: 'm' },
      },
    }))
    expect(transcript.view()).toEqual([])
  })

  it('records tool calls with a bounded arguments preview and marks their results', () => {
    const transcript = new Transcript()
    transcript.consume(event('tool/call', {
      turn: 0, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"echo hi"}',
    }))
    transcript.consume(event('tool/result', {
      turn: 0,
      step: 1,
      message: {
        role: 'user',
        id: 'r',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'hi' }] }],
        source: { kind: 'tool', toolName: 'bash', callId: 'call-1' },
      },
    }))
    expect(transcript.view()).toEqual([
      { kind: 'tool', text: 'bash {"command":"echo hi"}' },
      { kind: 'tool-result', text: '✓ bash (2 B)' },
    ])
  })

  it('marks failed tool results with their size omitted', () => {
    const transcript = new Transcript()
    transcript.consume(event('tool/result', {
      turn: 0,
      step: 1,
      error: { name: 'X', code: 'BROKEN' },
      message: {
        role: 'user',
        id: 'r',
        content: [{ type: 'tool-result', toolCallId: 'call-9', content: [], isError: true }],
        source: { kind: 'tool', toolName: 'bash', callId: 'call-9' },
      },
    }))
    expect(transcript.view()).toEqual([{ kind: 'tool-result', text: '✗ tool' }])
  })

  it('truncates over-long tool arguments', () => {
    const transcript = new Transcript()
    transcript.consume(event('tool/call', {
      turn: 0, step: 1, callId: 'c', name: 'write',
      arguments: 'x'.repeat(300),
    }))
    const entry = transcript.view()[0]
    expect(entry?.kind).toBe('tool')
    expect(entry?.text.length).toBeLessThan(300)
    expect(entry?.text.endsWith('…')).toBe(true)
  })

  it('projects turn endings: errors, aborts, and max-tokens', () => {
    const transcript = new Transcript()
    transcript.consume(event('turn/end', {
      turn: 0,
      reason: { kind: 'error', error: { code: 'SERVER', message: 'down' } },
    }))
    transcript.consume(event('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    }))
    transcript.consume(event('turn/end', {
      turn: 2,
      reason: { kind: 'max-tokens' },
    }))
    transcript.consume(event('turn/end', { turn: 3, reason: { kind: 'completed' } }))
    expect(transcript.view()).toEqual([
      { kind: 'error', text: 'SERVER: down' },
      { kind: 'info', text: 'interrupted' },
      { kind: 'info', text: 'the response reached its max-token limit' },
    ])
  })

  it('ignores presentation-only event types', () => {
    const transcript = new Transcript()
    transcript.consume(event('turn/start', { turn: 0 }))
    transcript.consume(event('step/start', { turn: 0, step: 1 }))
    transcript.consume(event('assistant/chunk', { turn: 0, step: 1, chunk: { kind: 'chunk' } }))
    transcript.consume(event('step/end', { turn: 0, step: 1 }))
    expect(transcript.view()).toEqual([])
  })

  it('caps the record count, dropping the oldest entries', () => {
    const transcript = new Transcript()
    for (let index = 0; index < 450; index++) transcript.push('info', `line ${index}`)
    const view = transcript.view()
    expect(view.length).toBe(400)
    expect(view[0]?.text).toBe('line 50')
  })

  it('truncates over-long records with an ellipsis', () => {
    const transcript = new Transcript()
    transcript.push('info', 'x'.repeat(9000))
    const entry = transcript.view()[0]
    expect(entry?.text).toBe('x'.repeat(8000) + ' …')
  })

  it('renders records as styled lines with kind prefixes', () => {
    const transcript = new Transcript()
    transcript.push('user', 'prompt')
    transcript.push('tool-result', '✓ bash (2 B)')
    transcript.push('error', 'boom')
    expect(transcript.lines()).toEqual([
      { text: '› prompt', style: 'bold' },
      { text: '  ✓ bash (2 B)', style: 'dim' },
      { text: '✗ boom', style: 'red' },
    ])
  })
})

describe('Transcript edge cases', () => {
  it('treats a text block without text as empty', () => {
    const transcript = new Transcript()
    transcript.consume(event('assistant/message', {
      turn: 0,
      step: 1,
      message: {
        role: 'assistant',
        id: 'm',
        content: [{ type: 'text' }],
        source: { provider: 'p', model: 'm' },
      },
    }))
    expect(transcript.view()).toEqual([])
  })

  it('ignores an empty human message', () => {
    const transcript = new Transcript()
    transcript.consume(event('user/message', {
      content: [],
      source: { kind: 'user' },
    }))
    expect(transcript.view()).toEqual([])
  })

  it('marks a tool result without a matching block as a bare tool', () => {
    const transcript = new Transcript()
    transcript.consume(event('tool/result', {
      turn: 0,
      step: 1,
      message: {
        role: 'user',
        id: 'r',
        content: [],
        source: { kind: 'tool', toolName: 'bash', callId: 'x' },
      },
    }))
    expect(transcript.view()).toEqual([{ kind: 'tool-result', text: '✓ tool' }])
  })

  it('measures only text bytes of a tool result', () => {
    const transcript = new Transcript()
    transcript.consume(event('tool/call', {
      turn: 0, step: 1, callId: 'c', name: 'read', arguments: '{}',
    }))
    transcript.consume(event('tool/result', {
      turn: 0,
      step: 1,
      message: {
        role: 'user',
        id: 'r',
        content: [{
          type: 'tool-result',
          toolCallId: 'c',
          content: [{ type: 'text', text: 'abc' }, { type: 'image', attachmentId: 'i' }],
        }],
        source: { kind: 'tool', toolName: 'read', callId: 'c' },
      },
    }))
    expect(transcript.view()).toEqual([
      { kind: 'tool', text: 'read {}' },
      { kind: 'tool-result', text: '✓ read (3 B)' },
    ])
  })
})

describe('Transcript byte measurement edge', () => {
  it('counts a text part without text as zero bytes', () => {
    const transcript = new Transcript()
    transcript.consume(event('tool/result', {
      turn: 0,
      step: 1,
      message: {
        role: 'user',
        id: 'r',
        content: [{
          type: 'tool-result',
          toolCallId: 'c',
          content: [{ type: 'text' }],
        }],
        source: { kind: 'tool', toolName: 'read', callId: 'c' },
      },
    }))
    expect(transcript.view()).toEqual([{ kind: 'tool-result', text: '✓ tool' }])
  })
})
