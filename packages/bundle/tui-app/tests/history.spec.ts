/** Prompt-history navigation. */

import { describe, expect, it } from 'vitest'
import { PromptHistory } from '../src/history.ts'

describe('PromptHistory', () => {
  it('records submissions and ignores consecutive duplicates', () => {
    const history = new PromptHistory(['one', 'two', 'two', 'three'])
    expect(history.navigate(1, '')).toBe('three')
    expect(history.navigate(1, 'three')).toBe('two')
    expect(history.navigate(1, 'two')).toBe('one')
  })

  it('restores the live draft when navigating back down', () => {
    const history = new PromptHistory(['older', 'newer'])
    expect(history.navigate(1, 'draft')).toBe('newer')
    expect(history.navigate(-1, 'newer')).toBe('draft')
    expect(history.navigate(-1, 'draft')).toBe('draft')
  })

  it('stays at the oldest entry on repeated older navigation', () => {
    const history = new PromptHistory(['only'])
    expect(history.navigate(1, '')).toBe('only')
    expect(history.navigate(1, 'only')).toBe('only')
  })

  it('resets to live editing after a new submission', () => {
    const history = new PromptHistory(['one'])
    history.navigate(1, '')
    history.push('two')
    expect(history.navigate(-1, '')).toBe('')
  })
})

describe('PromptHistory caps and resets', () => {
  it('drops the oldest entry past the cap', () => {
    const history = new PromptHistory()
    for (let index = 0; index < 101; index++) history.push(`p${index}`)
    expect(history.navigate(1, '')).toBe('p100')
    // Walk all the way back: the oldest survivor is p1 (p0 was dropped).
    let value = 'p100'
    for (let index = 0; index < 99; index++) value = history.navigate(1, value)
    expect(value).toBe('p1')
  })

  it('returns to live editing when a duplicate is resubmitted mid-navigation', () => {
    const history = new PromptHistory(['one', 'two'])
    history.navigate(1, '')
    history.push('two') // duplicate of the newest entry
    expect(history.navigate(1, '')).toBe('two') // starts from the top again
  })
})
