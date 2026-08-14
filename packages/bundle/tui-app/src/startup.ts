/**
 * The TUI app's command-line provider: it parses the optional initial prompt
 * positional (`dsh tui "run the tests"`) and this app's `--help`, then
 * provides the values as {@link TUI_STARTUP_SERVICE}. Ordinary rows inject
 * that service before reading it from lazy config.
 * @module @deepseek-ai/dsh-tui-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the invocation can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the TUI runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** The optional first prompt, submitted as soon as the TUI is ready. */
  initialPrompt?: string
}

/**
 * This app's command: the optional initial prompt, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh tui')
    .description('Start the interactive terminal interface for one agent conversation.')
    .helpOption('-h, --help', 'show this help')
    .argument('[prompt...]', 'optional first prompt; multiple words are joined by spaces')
    .addHelpText('after', `
Examples:
  dsh tui                              start an empty conversation
  dsh tui "run the tests"              start with an initial prompt
`)
}

/**
 * Parse and provide the TUI invocation as an ordinary Cordis service. The
 * command's action publishes the joined positional prompt; on `--help` (and
 * a usage error) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const prompt = program.args.join(' ')
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...prompt.trim() !== '' ? { initialPrompt: prompt } : {},
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
