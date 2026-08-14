/**
 * The TUI app's ordinary command-line provider over a real Loader tree: the
 * optional prompt positional becomes the provided service value, while help
 * and usage errors leave the consumer pending.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  runnerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider over a runner stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the resolved service value and observed runner/process effects.
 */
async function bootStartup(args: string[]): Promise<{ values: TuiStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__tuiStartupObserved.runnerConfig = config }\n')
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__tuiStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: tui-runner',
    `  name: ${rowUrl}`,
    `  inject: [${TUI_STARTUP_SERVICE}]`,
    '  config:',
    '    initialPrompt: !!js ctx.tuiStartup.initialPrompt',
    '- id: tui-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __tuiStartupApply: typeof apply
    __tuiStartupObserved: Observed
  }
  globals.__tuiStartupApply = apply
  globals.__tuiStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    values: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    observed,
  }
}

describe('tui command-line provider', () => {
  it('joins the prompt positional into the runner config', async () => {
    const { values, observed } = await bootStartup(['run', 'the', 'tests'])
    expect(values).toEqual({ initialPrompt: 'run the tests' })
    expect(observed.runnerConfig).toEqual({ initialPrompt: 'run the tests' })
    expect(observed.exits).toEqual([])
  })

  it('provides an empty invocation with no prompt', async () => {
    const { values, observed } = await bootStartup([])
    expect(values).toEqual({})
    expect(observed.runnerConfig).toEqual({})
    expect(observed.exits).toEqual([])
  })

  it('provides no initial prompt for a whitespace-only positional', async () => {
    const { values, observed } = await bootStartup(['   '])
    expect(values).toEqual({})
    expect(observed.runnerConfig).toEqual({})
    expect(observed.exits).toEqual([])
  })

  it('prints its own help and leaves the runner pending', async () => {
    const { values, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh tui')
    expect(observed.out).toContain('initial prompt')
    expect(values).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })
})
