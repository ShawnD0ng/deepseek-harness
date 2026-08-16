/** Slash-command completion helpers. */

import { describe, expect, it } from 'vitest'
import { commandCandidates, completedCommand } from '../src/complete.ts'

const NAMES = ['compact', 'exit', 'goal', 'help'] as const

describe('commandCandidates', () => {
  it('lists every command for a bare slash', () => {
    expect(commandCandidates(NAMES, '/')).toEqual(NAMES)
  })

  it('filters by the typed prefix in registry order', () => {
    expect(commandCandidates(NAMES, '/co')).toEqual(['compact'])
    expect(commandCandidates(NAMES, '/e')).toEqual(['exit'])
    expect(commandCandidates(NAMES, '/g')).toEqual(['goal'])
  })

  it('returns nothing for a prefix no command shares', () => {
    expect(commandCandidates(NAMES, '/zz')).toEqual([])
  })

  it('returns nothing once the line names its command with arguments', () => {
    expect(commandCandidates(NAMES, '/exit now')).toEqual([])
    expect(commandCandidates(NAMES, '/goal ')).toEqual([])
  })

  it('returns nothing for a line that is not a command prefix', () => {
    expect(commandCandidates(NAMES, 'hello')).toEqual([])
    expect(commandCandidates(NAMES, '')).toEqual([])
  })
})

describe('completedCommand', () => {
  it('rebuilds the line as the completed command with the cursor at its end', () => {
    expect(completedCommand('compact')).toEqual({ value: '/compact', cursor: 8 })
  })
})
