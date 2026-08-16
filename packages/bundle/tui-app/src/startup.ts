/**
 * The TUI app's command-line provider: it parses the optional initial prompt
 * positional (`dsh tui "run the tests"`), the resume flags (`--resume [id]`,
 * `--list`), and this app's `--help`, then provides the values as
 * {@link TUI_STARTUP_SERVICE}. Ordinary rows inject that service before
 * reading it from lazy config.
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
  /** A persisted session id to resume exactly (`--resume <id>`). */
  resumeId?: string
  /** Ask the runner to show a recent-session picker (`--resume` with no id). */
  resumeSelect?: boolean
  /** Print recent sessions and exit (`--list`). */
  list?: boolean
}

/**
 * This app's command: the optional initial prompt, the resume flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh tui')
    .description('Start the interactive terminal interface for one agent conversation.')
    .helpOption('-h, --help', 'show this help')
    .argument('[prompt...]', 'optional first prompt; multiple words are joined by spaces')
    .option('--resume [id]', 'resume a persisted session; the id loads it exactly, and no id opens a recent-session picker')
    .option('--list', 'list recent sessions and exit')
    .addHelpText('after', `
Examples:
  dsh tui                              start an empty conversation
  dsh tui "run the tests"              start with an initial prompt
  dsh tui --resume session-abc         resume one persisted session
  dsh tui --resume                     pick a recent session to resume
  dsh tui --list                       print recent sessions and exit
`)
}

/**
 * Parse and provide the TUI invocation as an ordinary Cordis service. The
 * command's action publishes the joined positional prompt and the resume
 * intent; on `--help` (and a usage error) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts<{ resume?: string | true; list?: boolean }>()
    const prompt = program.args.join(' ')
    const values: TuiStartupValues = {
      ...prompt.trim() !== '' ? { initialPrompt: prompt } : {},
      ...options.resume !== undefined && options.resume !== true ? { resumeId: options.resume } : {},
      ...options.resume === true ? { resumeSelect: true } : {},
      ...options.list === true ? { list: true } : {},
    }
    ctx.provide(TUI_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
