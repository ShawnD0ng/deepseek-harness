/**
 * @deepseek-ai/dsh-tui-app — the interactive terminal driver. The bundle
 * patch rides over dsh-base without Host, HTTP, or browser plugins; this
 * runner creates one Agent through the core registry, drives a full-screen
 * TUI over the process TTY, streams the session log into a transcript,
 * answers ask-user questions and approval prompts in line, and exits through
 * the launcher's bounded shutdown.
 *
 * @module @deepseek-ai/dsh-tui-app
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import type ToolRuntime from '@deepseek-ai/dsh-tools'
import type SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import {
  UserQuestionError,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionRequest,
  type UserQuestionProvider,
  type UserQuestionService,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { CommandExecution, CommandRuntime } from '@deepseek-ai/dsh-commands'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { PromptHistory } from './history.ts'
import { commandCandidates, completedCommand } from './complete.ts'
import type { Key } from './keys.ts'
import { composeFrame, diffFrames, wrapText, type Frame, type FrameInput } from './render.ts'
import { createTtyTerminal, type TerminalDriver, type TtyInput, type TtyOutput } from './terminal.ts'
import { Transcript, type ToolPresenter } from './transcript.ts'
import { findWordBackward, findWordForward } from './word.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the invocation resolved from this app's injected provider service. */
export interface Config {
  /** The optional first prompt, submitted as soon as the TUI is ready. */
  initialPrompt?: string
  /** A persisted session id to resume exactly (`--resume <id>`); empty means fresh. */
  resumeId?: string
  /** Open a recent-session picker instead of starting fresh (`--resume` with no id). */
  resumeSelect?: boolean
  /** Print recent sessions and exit (`--list`). */
  list?: boolean
}

export const Config: z<Config> = z.object({
  initialPrompt: z.string().default(''),
  resumeId: z.string().default(''),
  resumeSelect: z.boolean().default(false),
  list: z.boolean().default(false),
})

/** The process streams the TUI writes to; tests substitute captures. */
export const internals: {
  stdin: TtyInput
  stdout: TtyOutput
  stderr: { write(chunk: string): unknown }
  createTerminal: (stdin: TtyInput, stdout: TtyOutput) => TerminalDriver
} = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  createTerminal: createTtyTerminal,
}

/** Process-facing effects of one TUI run. */
interface TuiIo {
  stdin: TtyInput
  stdout: TtyOutput
  stderr: { write(chunk: string): unknown }
}

/** One pending ask-user request. */
interface PendingQuestion {
  readonly kind: 'question'
  readonly request: AskUserQuestionRequest
  /** Answers collected so far, in question order. */
  answers: AskUserQuestionAnswerItem[]
  resolve: (answer: { answers: AskUserQuestionAnswerItem[] }) => void
  reject: (error: unknown) => void
}

/** One pending approval decision. */
interface PendingConfirm {
  readonly kind: 'confirm'
  readonly request: ApprovalRequest
  resolve: (outcome: ApprovalOutcome) => void
}

/** Anything the footer can be busy answering. */
type Pending = PendingQuestion | PendingConfirm

/** Report an unexpected driver failure and request a failing exit. */
function fail(io: TuiIo, exit: (code: number) => void, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(1)
}

/**
 * Mount the interactive terminal driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - the resolved invocation; its optional initial prompt is submitted once the interface is ready.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  // A signal (or any fiber disposal) mid-run restores the terminal even when
  // the ordinary exit path never runs.
  const held: { terminal?: TerminalDriver } = {}
  ctx.effect(() => () => { held.terminal?.restore() })
  const io: TuiIo = { stdin: internals.stdin, stdout: internals.stdout, stderr: internals.stderr }
  void run(ctx, config, io, exit, held).catch((error: unknown) => { fail(io, exit, error) })
}

/**
 * Boot the TUI: settle the Loader, create or resume one Agent, drive the terminal.
 * @param ctx - plugin context.
 * @param config - the resolved invocation (optional initial prompt, resume intent, list).
 * @param io - process-facing effects.
 * @param exit - the launcher's bounded exit request.
 * @param held - terminal holder for the fiber-disposal restore.
 */
async function run(
  ctx: Context, config: Config, io: TuiIo, exit: (code: number) => void, held: { terminal?: TerminalDriver },
): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return
  const sessionStore = sessions

  const selection = defaultModel.currentSelection()
  // Fails loud when the process has no interactive terminal.
  const terminal = internals.createTerminal(io.stdin, io.stdout)
  held.terminal = terminal
  const toolsService = ctx.get('tools') as ToolRuntime | undefined
  // Bridge the shared tool registry's declared card views into the transcript;
  // the transcript contains projector failures itself.
  const presenter: ToolPresenter | undefined = toolsService === undefined ? undefined : {
    presentCall(name, args) {
      const definition = toolsService.get(name)
      return definition?.presentCall?.(args)
    },
    presentResult(name, args, result) {
      const definition = toolsService.get(name)
      return definition?.presentResult?.(args, result)
    },
  }
  const tokenMeter = ctx.get('tokenMeter') as TokenMeter | undefined

  const transcript = new Transcript(presenter)
  const history = new PromptHistory()
  const color = process.env.NO_COLOR === undefined

  // All interactive state is declared before the registrations below, so an
  // ask arriving before the Agent exists still finds initialized state.
  let myAgent: Agent | undefined
  let sessionRef: Session | undefined
  let buffer = ''
  let cursor = 0
  let bodyOffset = 0
  let busy = false
  let turn = 0
  let notice: string | undefined
  let renderCount = 0
  let prevFrame: Frame | undefined
  let renderScheduled = false
  let exited = false
  let current: Pending | undefined
  const queue: Pending[] = []
  let questionIndex = 0
  let selected = 0
  let toggled = new Set<number>()
  let completion: { options: readonly string[]; selected: number } | undefined
  let killRing: string[] = []
  let yankSpan: { start: number; length: number; text: string; index: number } | undefined
  let contextTokens: number | undefined
  let picker: { records: SessionRecord[]; selected: number; resolve: (id: string) => void } | undefined

  /** Humanize one token count for the status row. */
  function formatTokens(tokens: number): string {
    if (tokens >= 10000) return `${(tokens / 1000).toFixed(0)}k`
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
    return String(tokens)
  }

  /** Paint one frame; the diff only rewrites changed rows. */
  function render(): void {
    const contextLabel = contextTokens === undefined ? '' : ` · ctx ${formatTokens(contextTokens)}`
    const input: FrameInput = {
      body: transcript.lines(),
      bodyOffset,
      status: {
        left: `${selection.provider} ${selection.model}`,
        right: `${busy ? `turn ${turn}` : 'ready'}${contextLabel}`,
        busy,
        spinner: renderCount,
      },
    }
    if (notice !== undefined) input.notice = notice
    if (picker !== undefined) {
      input.question = {
        title: 'Resume a session',
        options: picker.records.map(formatSessionLine),
        selected: picker.selected,
      }
    } else if (current?.kind === 'question') {
      // The service admits only non-empty question lists, and pump resets the
      // index per interaction, so the active question always exists.
      const question = current.request.questions[questionIndex]!
      const options = question.options ?? []
      if (options.length > 0) {
        input.question = {
          title: question.header === undefined ? question.question : `${question.header}: ${question.question}`,
          ...question.detail !== undefined ? { detail: question.detail } : {},
          options: options.map(option => option.label),
          selected,
          ...question.multiSelect === true
            ? { checked: options.map((_option, index) => toggled.has(index)) }
            : {},
        }
      } else {
        input.input = { prompt: '❯ ', value: buffer, cursor, placeholder: question.question }
      }
    } else if (current?.kind === 'confirm') {
      input.confirm = {
        message: `Allow ${current.request.toolName}?`,
        ...current.request.reason !== undefined ? { detail: current.request.reason } : {},
        choices: ['allow', 'reject'],
        selected,
      }
    } else {
      input.input = { prompt: '❯ ', value: buffer, cursor, placeholder: 'ask the agent — /help lists commands' }
      if (completion !== undefined) {
        input.input.completion = { options: completion.options, selected: completion.selected }
      }
    }
    const next = composeFrame(input, terminal.width, terminal.height, color)
    terminal.write(diffFrames(prevFrame, next, color))
    prevFrame = next
    renderCount += 1
  }

  /** Coalesce render requests into one paint per macrotask batch. */
  function requestRender(): void {
    if (renderScheduled || exited) return
    renderScheduled = true
    queueMicrotask(() => {
      renderScheduled = false
      if (!exited) render()
    })
  }

  /** Flush the session after each committed turn so storage stays current. */
  function flushSession(): void {
    // Only the session/event handler calls this, after matching sessionRef.
    void sessionStore.flush(sessionRef!).catch((error: unknown) => {
      ctx.logger.warn(`tui: session flush failed: ${String(error)}`)
    })
  }

  /** Request process exit after the session flushes; fiber disposal restores the terminal. */
  function requestExit(code: number): void {
    if (exited) return
    exited = true
    const session = sessionRef
    const flush = session === undefined
      ? Promise.resolve()
      : sessionStore.flush(session).catch((error: unknown) => {
        ctx.logger.warn(`tui: session flush failed: ${String(error)}`)
      })
    void flush.then(() => { exit(code) })
  }

  /** Abort the running turn (ctrl-c while busy; the caller checks `busy`). */
  function cancelTurn(): void {
    // `busy` turns on only through this session's own turn/start, which
    // cannot precede the agent assignment it shares with `sessionRef`.
    myAgent!.cancel({ kind: 'user' })
    notice = 'interrupted'
    requestRender()
  }

  /** Start the next queued interaction, if any. */
  function pump(): void {
    if (current !== undefined || queue.length === 0) return
    current = queue.shift()
    questionIndex = 0
    selected = 0
    toggled = new Set()
    buffer = ''
    cursor = 0
    completion = undefined
    requestRender()
  }

  /** Close the current interaction and open the next. */
  function advanceInteraction(): void {
    current = undefined
    pump()
    requestRender()
  }

  /** Withdraw a queued or active question, rejecting its asker. */
  function abortQuestion(pending: PendingQuestion): void {
    if (current === pending) {
      current = undefined
      pump()
      requestRender()
    } else {
      const index = queue.indexOf(pending)
      if (index >= 0) queue.splice(index, 1)
    }
    pending.reject(new UserQuestionError('ask_user_question was cancelled by the user', 'ASK_ABORTED'))
  }

  /** Close a queued or active approval with a final outcome. */
  function settleConfirm(pending: PendingConfirm, outcome: ApprovalOutcome): void {
    if (current === pending) advanceInteraction()
    else {
      const index = queue.indexOf(pending)
      if (index >= 0) queue.splice(index, 1)
    }
    pending.resolve(outcome)
  }

  /** Insert one character at the cursor. */
  function insertChar(char: string): void {
    buffer = buffer.slice(0, cursor) + char + buffer.slice(cursor)
    cursor += char.length
    requestRender()
  }

  /** Delete one character before the cursor. */
  function backspace(): void {
    if (cursor <= 0) return
    // A positive cursor always leaves at least one character behind it.
    const removed = buffer.slice(0, cursor).at(-1)!
    buffer = buffer.slice(0, cursor - removed.length) + buffer.slice(cursor)
    cursor -= removed.length
    requestRender()
  }

  /** Delete one character at the cursor. */
  function deleteForward(): void {
    if (cursor >= buffer.length) return
    // The guard leaves at least one character at the cursor.
    const removed = buffer.at(cursor)!
    buffer = buffer.slice(0, cursor) + buffer.slice(cursor + removed.length)
    requestRender()
  }

  /** Delete trailing whitespace and the word before the cursor (ctrl-w), remembering it for yank. */
  function deleteWord(): void {
    let end = cursor
    while (end > 0 && buffer[end - 1]! === ' ') end -= 1
    while (end > 0 && buffer[end - 1]! !== ' ') end -= 1
    pushKill(buffer.slice(end, cursor))
    buffer = buffer.slice(0, end) + buffer.slice(cursor)
    cursor = end
    requestRender()
  }

  /** Delete the word at the cursor (alt+d), remembering it for yank. */
  function deleteWordForward(): void {
    if (cursor >= buffer.length) return
    const end = findWordForward(buffer, cursor)
    pushKill(buffer.slice(cursor, end))
    buffer = buffer.slice(0, cursor) + buffer.slice(end)
    requestRender()
  }

  /** Delete to the line end (ctrl+k), remembering it for yank. */
  function deleteToEnd(): void {
    if (cursor >= buffer.length) return
    pushKill(buffer.slice(cursor))
    buffer = buffer.slice(0, cursor)
    requestRender()
  }

  /** Delete to the line start (ctrl+u), remembering it for yank. */
  function deleteToStart(): void {
    if (cursor <= 0) return
    pushKill(buffer.slice(0, cursor))
    buffer = buffer.slice(cursor)
    cursor = 0
    requestRender()
  }

  /** Alt-character bindings (the terminal encodes alt as ESC + character). */
  function handleAltChar(char: string): void {
    switch (char) {
      case 'b':
        cursor = findWordBackward(buffer, cursor)
        requestRender()
        break
      case 'f':
        cursor = findWordForward(buffer, cursor)
        requestRender()
        break
      case 'd':
        deleteWordForward()
        break
      case 'y':
        yankPop()
        break
      default:
        break
    }
  }

  /** Remember one killed span for later yanking. */
  function pushKill(text: string): void {
    if (text === '') return
    killRing = [text, ...killRing].slice(0, 10)
  }

  /** Insert the most recent kill at the cursor. */
  function yank(): void {
    const text = killRing[0]
    if (text === undefined) return
    buffer = buffer.slice(0, cursor) + text + buffer.slice(cursor)
    yankSpan = { start: cursor, length: text.length, text, index: 0 }
    cursor += text.length
    requestRender()
  }

  /** Swap the yanked span for the previous kill (alt+y). */
  function yankPop(): void {
    if (yankSpan === undefined || killRing.length < 2) return
    // The span only tracks the yanked text; a buffer replaced wholesale
    // (history, submit, a new question) ends the span instead.
    if (buffer.slice(yankSpan.start, yankSpan.start + yankSpan.length) !== yankSpan.text) {
      yankSpan = undefined
      return
    }
    const index = (yankSpan.index + 1) % killRing.length
    const text = killRing[index]!
    buffer = buffer.slice(0, yankSpan.start) + text + buffer.slice(yankSpan.start + yankSpan.length)
    cursor = yankSpan.start + text.length
    yankSpan = { start: yankSpan.start, length: text.length, text, index }
    requestRender()
  }

  /** Scroll the transcript viewport by `lines` wrapped rows (negative scrolls toward the bottom). */
  function scrollBy(lines: number): void {
    bodyOffset = lines >= 0 ? bodyOffset + lines : Math.max(0, bodyOffset + lines)
    requestRender()
  }

  /** Scroll the transcript viewport by one page. */
  function scroll(direction: 1 | -1): void {
    const page = Math.max(1, terminal.height - 4)
    scrollBy(direction === 1 ? page : -page)
  }

  /** Jump the viewport so the previous (or next) user prompt sits at the top. */
  function jumpPrompt(direction: 1 | -1): void {
    const body = transcript.lines()
    const userIndices = transcript.userIndices()
    if (userIndices.length === 0) return
    const width = Math.max(1, terminal.width)
    // The renderer's body viewport: everything but the status row and the
    // single input row (a completion popup or a wrapped input shrinks it
    // further, which only nudges the landing row).
    const height = Math.max(1, terminal.height - 2)
    // First wrapped row of each entry, matching the renderer's wrap.
    const starts: number[] = []
    let total = 0
    for (const line of body) {
      starts.push(total)
      total += wrapText(line.text, width).length
    }
    const top = Math.max(0, total - height - bodyOffset)
    // The focused prompt is the last one whose first row is at or above the top.
    let focus = 0
    for (let index = 0; index < userIndices.length; index++) {
      if (starts[userIndices[index]!]! <= top) focus = index
      else break
    }
    const target = focus + direction
    if (target < 0) return
    if (target >= userIndices.length) {
      bodyOffset = 0
      requestRender()
      return
    }
    bodyOffset = Math.max(0, total - height - starts[userIndices[target]!]!)
    requestRender()
  }

  /** The runtime's command names, or nothing while commands or the Agent are unavailable. */
  function commandNames(): readonly string[] {
    const runtime = ctx.get('commands') as CommandRuntime | undefined
    const agent = myAgent
    if (runtime === undefined || agent === undefined) return []
    return runtime.list(agent).map(command => command.name)
  }

  /**
   * Open the completion popup for the current buffer, filling the buffer
   * directly when exactly one command matches.
   * @returns true when the popup opened or a lone match filled the buffer.
   */
  function openCompletion(): boolean {
    const candidates = commandCandidates(commandNames(), buffer)
    if (candidates.length === 0) return false
    completion = { options: candidates, selected: 0 }
    if (candidates.length === 1) acceptCompletion()
    else requestRender()
    return true
  }

  /** Fill the buffer with the highlighted candidate and close the popup. */
  function acceptCompletion(): void {
    // Callers only invoke this with an open popup, whose non-empty
    // candidates always contain the selection index.
    const name = completion!.options[completion!.selected]!
    completion = undefined
    const applied = completedCommand(name)
    buffer = applied.value
    cursor = applied.cursor
    requestRender()
  }

  /** Move the popup highlight by one row, wrapping at both ends. */
  function moveCompletion(delta: 1 | -1): void {
    // Callers only invoke this with an open popup.
    const current = completion!
    const count = current.options.length
    completion = { options: current.options, selected: (current.selected + delta + count) % count }
    requestRender()
  }

  /**
   * Shared single-line editing keys (input mode and free-text questions).
   * @param key - the decoded keystroke.
   * @param actions - submit and escape closures for the owning interaction.
   * @param complete - whether slash-command completion is armed (input mode only).
   */
  function handleEditorKey(key: Key, actions: { submit: () => void; escape: () => void }, complete: boolean): void {
    switch (key.kind) {
      case 'up':
        if (complete && completion !== undefined) {
          moveCompletion(-1)
        } else if (key.modifiers?.includes('ctrl') === true && key.modifiers?.includes('shift') === true) {
          jumpPrompt(-1)
        } else if (key.modifiers?.includes('ctrl') === true) {
          scrollBy(Math.ceil((Math.max(1, terminal.height - 4)) / 2))
        } else if (key.modifiers?.includes('alt') === true) {
          scrollBy(1)
        } else {
          buffer = history.navigate(1, buffer)
          cursor = buffer.length
          requestRender()
        }
        break
      case 'down':
        if (complete && completion !== undefined) {
          moveCompletion(1)
        } else if (key.modifiers?.includes('ctrl') === true && key.modifiers?.includes('shift') === true) {
          jumpPrompt(1)
        } else if (key.modifiers?.includes('ctrl') === true) {
          scrollBy(-Math.ceil((Math.max(1, terminal.height - 4)) / 2))
        } else if (key.modifiers?.includes('alt') === true) {
          scrollBy(-1)
        } else {
          buffer = history.navigate(-1, buffer)
          cursor = buffer.length
          requestRender()
        }
        break
      case 'enter':
        if (complete && completion !== undefined) acceptCompletion()
        else actions.submit()
        break
      case 'tab':
        if (complete && completion !== undefined) {
          acceptCompletion()
        } else if (complete) {
          // A popup open (or a lone match accepted) already rendered; fall
          // through to indentation only when the line is not a command prefix.
          if (!openCompletion() && !buffer.startsWith('/')) insertChar('  ')
        } else {
          insertChar('  ')
        }
        break
      case 'escape':
        if (complete && completion !== undefined) {
          completion = undefined
          requestRender()
        } else {
          actions.escape()
        }
        break
      default:
        // Every editing key dismisses the popup: its list no longer matches.
        completion = undefined
        handleEditKey(key)
        break
    }
  }

  /** Editing keys that dismiss the completion popup and edit the line. */
  function handleEditKey(key: Key): void {
    switch (key.kind) {
      case 'char':
        if (key.modifiers?.includes('alt') === true) handleAltChar(key.char)
        else insertChar(key.char)
        break
      case 'backspace':
        backspace()
        break
      case 'delete':
        deleteForward()
        break
      case 'left':
        cursor = (key.modifiers?.length ?? 0) > 0
          ? findWordBackward(buffer, cursor)
          : Math.max(0, cursor - 1)
        requestRender()
        break
      case 'right':
        cursor = (key.modifiers?.length ?? 0) > 0
          ? findWordForward(buffer, cursor)
          : Math.min(buffer.length, cursor + 1)
        requestRender()
        break
      case 'home':
        cursor = 0
        requestRender()
        break
      case 'end':
        cursor = buffer.length
        requestRender()
        break
      case 'page-up':
        scroll(1)
        break
      case 'page-down':
        scroll(-1)
        break
      case 'ctrl':
        switch (key.letter) {
          case 'a':
            cursor = 0
            requestRender()
            break
          case 'e':
            cursor = buffer.length
            requestRender()
            break
          case 'u':
            deleteToStart()
            break
          case 'k':
            deleteToEnd()
            break
          case 'w':
            deleteWord()
            break
          case 'y':
            yank()
            break
          case 'n':
            buffer = history.navigate(-1, buffer)
            cursor = buffer.length
            requestRender()
            break
          case 'p':
            buffer = history.navigate(1, buffer)
            cursor = buffer.length
            requestRender()
            break
          case 'c':
            if (buffer !== '') {
              buffer = ''
              cursor = 0
              requestRender()
            } else if (busy) {
              cancelTurn()
            } else {
              requestExit(0)
            }
            break
          case 'd':
            if (buffer === '') requestExit(0)
            else deleteForward()
            break
          case 'l': {
            prevFrame = undefined
            requestRender()
            break
          }
          default:
            break
        }
        break
    }
  }

  /** Send one submitted line as a prompt, or run it as a slash command. */
  /** A submitted line that arrived before the Agent existed, replayed on creation. */
  let pendingPrompt: string | undefined

  function submit(): void {
    const value = buffer.trim()
    buffer = ''
    cursor = 0
    completion = undefined
    notice = undefined
    if (value === '') {
      requestRender()
      return
    }
    history.push(value)
    if (myAgent === undefined) {
      // Typed (or pasted) before the Agent finished starting: hold the line
      // instead of dropping it.
      pendingPrompt = value
      requestRender()
      return
    }
    if (value.startsWith('/')) {
      void submitCommand(value)
      return
    }
    myAgent.followup(createUserMessage({
      content: [{ type: 'text', text: value }],
      source: { kind: 'user' },
    }))
    requestRender()
  }

  /** Execute one slash command through the shared command runtime. */
  async function submitCommand(line: string): Promise<void> {
    const commands = ctx.get('commands') as CommandRuntime | undefined
    // `submit` only reaches here once the agent exists.
    const agent = myAgent!
    if (commands === undefined) {
      // No command runtime composed: the line reaches the model unchanged.
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: line }],
        source: { kind: 'user' },
      }))
      requestRender()
      return
    }
    try {
      const execution: CommandExecution | undefined = await commands.execute(agent, line, new AbortController().signal)
      if (execution === undefined) {
        notice = `unknown command: ${line}`
      } else if (execution.result.kind === 'success') {
        if (execution.result.text !== undefined) transcript.push('info', execution.result.text)
      } else {
        transcript.push('error', execution.result.text)
      }
    } catch (error) {
      transcript.push('error', error instanceof Error ? error.message : String(error))
    }
    requestRender()
  }

  /** Finish one question and advance to the next, or settle the request. */
  function finishQuestion(pending: PendingQuestion, answer: AskUserQuestionAnswerItem): void {
    pending.answers.push(answer)
    questionIndex += 1
    if (pending.request.questions[questionIndex] === undefined) {
      const answers = pending.answers
      advanceInteraction()
      pending.resolve({ answers })
      return
    }
    selected = 0
    toggled = new Set()
    buffer = ''
    cursor = 0
    requestRender()
  }

  /** Input-mode keys. */
  function handleInputKey(key: Key): void {
    handleEditorKey(key, {
      submit: () => { submit() },
      escape: () => {
        buffer = ''
        cursor = 0
        requestRender()
      },
    }, true)
  }

  /** Question-widget keys for the active question interaction. */
  function handleQuestionKey(key: Key, pending: PendingQuestion): void {
    // The service admits only non-empty question lists, and pump resets the
    // index per interaction, so the active question always exists.
    const question = pending.request.questions[questionIndex]!
    const options = question.options ?? []
    if (options.length === 0) {
      handleEditorKey(key, {
        submit: () => { finishQuestion(pending, { id: question.id, selected: [], custom: buffer }) },
        escape: () => { abortQuestion(pending) },
      }, false)
      return
    }
    switch (key.kind) {
      case 'up':
        selected = Math.max(0, selected - 1)
        requestRender()
        break
      case 'down':
        selected = Math.min(options.length - 1, selected + 1)
        requestRender()
        break
      case 'enter':
        if (question.multiSelect === true) {
          finishQuestion(pending, {
            id: question.id,
            selected: options.filter((_option, index) => toggled.has(index)).map(option => option.label),
          })
        } else {
          // The selection index always names an existing option.
          finishQuestion(pending, { id: question.id, selected: [options[selected]!.label] })
        }
        break
      case 'char':
        if (key.char === ' ' && question.multiSelect === true) {
          if (toggled.has(selected)) toggled.delete(selected)
          else toggled.add(selected)
          requestRender()
        }
        break
      case 'escape':
        abortQuestion(pending)
        break
      default:
        break
    }
  }

  /** Confirmation-widget keys (approval). */
  function handleConfirmKey(key: Key, pending: PendingConfirm): void {
    switch (key.kind) {
      case 'left':
      case 'right':
      case 'tab':
        selected = selected === 0 ? 1 : 0
        requestRender()
        break
      case 'enter':
        settleConfirm(pending, selected === 0 ? 'allowed-once' : 'rejected')
        break
      case 'escape':
        settleConfirm(pending, 'cancelled')
        break
      case 'char':
        if (key.char === 'y' || key.char === 'Y') settleConfirm(pending, 'allowed-once')
        else if (key.char === 'n' || key.char === 'N') settleConfirm(pending, 'rejected')
        break
      default:
        break
    }
  }

  // Register the in-line ask-user answerer.
  const userQuestions = ctx.get('userQuestions') as UserQuestionService | undefined
  if (userQuestions !== undefined) {
    const provider: UserQuestionProvider = {
      ask(request: AskUserQuestionRequest): Promise<{ answers: AskUserQuestionAnswerItem[] }> {
        // The service rejects an already-aborted signal at its own entry, so
        // the provider only races aborts that land while the question is shown.
        return new Promise((resolve, reject) => {
          const pending: PendingQuestion = { kind: 'question', request, answers: [], resolve, reject }
          const onAbort = (): void => {
            request.signal?.removeEventListener('abort', onAbort)
            abortQuestion(pending)
          }
          request.signal?.addEventListener('abort', onAbort, { once: true })
          queue.push(pending)
          pump()
        })
      },
    }
    const disposeProvider = userQuestions.registerProvider(provider)
    ctx.effect(() => () => { disposeProvider() })
  }

  // Answer approval requests for the TUI's own agent in line; everything else
  // delegates down the waterfall (subagent decisions reach their own UI).
  ctx.on('approval/request', (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
    if (request.agent !== myAgent) return next()
    if (request.signal?.aborted) return Promise.resolve<ApprovalOutcome>('cancelled')
    return new Promise<ApprovalOutcome>((resolve) => {
      const pending: PendingConfirm = { kind: 'confirm', request, resolve }
      const onAbort = (): void => {
        request.signal?.removeEventListener('abort', onAbort)
        settleConfirm(pending, 'cancelled')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      queue.push(pending)
      pump()
    })
  })

  // Register the TUI-owned commands; their handlers are UI effects (exit) or
  // presentational (help), so neither reaches the model.
  const commands = ctx.get('commands') as CommandRuntime | undefined
  if (commands !== undefined) {
    const disposeExit = commands.register({
      name: 'exit',
      description: 'exit the terminal interface',
      handler: () => {
        requestExit(0)
        return { kind: 'success' as const }
      },
    })
    const disposeHelp = commands.register({
      name: 'help',
      description: 'list the commands available in this session',
      handler: (invocation) => {
        const lines = commands.list(invocation.agent).map(command => `/${command.name} — ${command.description}`)
        return { kind: 'success' as const, text: lines.join('\n') }
      },
    })
    ctx.effect(() => () => { disposeExit(); disposeHelp() })
  }

  // Fold the session firehose into the transcript and repaint.
  ctx.on('session/event', (eventSession: Session, event: SessionEvent) => {
    if (eventSession !== sessionRef) return
    const before = transcript.view().length
    if (event.type === 'turn/start') {
      busy = true
      turn = event.data.turn
    } else if (event.type === 'turn/end') {
      busy = false
      flushSession()
      if (tokenMeter !== undefined) contextTokens = tokenMeter.measure(eventSession).totalTokens
    }
    transcript.consume(event)
    const added = transcript.view().length - before
    // A scrolled-up reader stays pinned to the same content.
    if (bodyOffset > 0 && added > 0) bodyOffset += added
    requestRender()
  })

  /** One picker/listing line for a session record. */
  function formatSessionLine(record: SessionRecord): string {
    return `${record.header.id}  ${new Date(record.header.createdAt).toISOString()}`
  }

  /** Recent sessions from the query corpus, newest first, or the live store as a fallback. */
  async function listRecentSessions(): Promise<SessionRecord[]> {
    const query = ctx.get('sessionQuery') as SessionQueryEngine | undefined
    const records = query === undefined
      ? sessionStore.list().map(session => ({ header: session.header, live: true, persisted: false }))
      : await query.listSessions()
    return [...records].sort((left, right) => right.header.createdAt - left.header.createdAt)
  }

  /** Wait for the user to pick one session, or resolve '' when they cancel. */
  function pickSession(records: SessionRecord[]): Promise<string> {
    return new Promise(resolve => {
      picker = { records, selected: 0, resolve }
      requestRender()
    })
  }

  /** Picker keys: up/down move, enter confirms, escape/ctrl-c cancel to a fresh session. */
  function handlePickerKey(key: Key): void {
    // The key dispatch only calls this while a picker is open.
    const active = picker!
    switch (key.kind) {
      case 'up':
        active.selected = Math.max(0, active.selected - 1)
        requestRender()
        break
      case 'down':
        active.selected = Math.min(active.records.length - 1, active.selected + 1)
        requestRender()
        break
      case 'enter':
        // A non-empty list keeps the selection index in bounds.
        picker = undefined
        active.resolve(active.records[active.selected]!.header.id)
        requestRender()
        break
      case 'escape':
        picker = undefined
        active.resolve('')
        requestRender()
        break
      case 'ctrl':
        if (key.letter === 'c') {
          picker = undefined
          active.resolve('')
          requestRender()
        }
        break
      default:
        break
    }
  }

  const offKey = terminal.onKey((key: Key) => {
    if (exited) return
    if (picker !== undefined) {
      handlePickerKey(key)
      return
    }
    const pending = current
    if (pending?.kind === 'confirm') handleConfirmKey(key, pending)
    else if (pending?.kind === 'question') handleQuestionKey(key, pending)
    else handleInputKey(key)
  })
  const offResize = terminal.onResize(() => { requestRender() })
  terminal.onClose(() => { requestExit(0) })
  ctx.effect(() => () => { offKey(); offResize() })

  // --list: print recent sessions and exit without entering the interface.
  if (config.list === true) {
    const records = await listRecentSessions()
    if (records.length > 0) io.stdout.write(records.map(formatSessionLine).join('\n') + '\n')
    requestExit(0)
    return
  }

  // Resolve the resume intent into a session id (or a fresh session).
  let resumeId = config.resumeId ?? ''
  if (resumeId === '' && config.resumeSelect === true) {
    const records = await listRecentSessions()
    if (records.length === 0) {
      notice = 'no sessions to resume'
      requestRender()
    } else {
      resumeId = await pickSession(records)
    }
  }

  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }

  if (resumeId !== '') {
    // Resume the persisted session and replay its log into the transcript.
    const { agent } = await agents.resume({
      resumeSessionId: SessionId(resumeId),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
    myAgent = agent
    sessionRef = agent.session
    for (const event of agent.session.events) transcript.consume(event)
  } else {
    const { agent } = await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
    myAgent = agent
    sessionRef = agent.session
  }

  requestRender()
  // Replay a line the user submitted while the Agent was still starting.
  if (pendingPrompt !== undefined) {
    const replay = pendingPrompt
    pendingPrompt = undefined
    buffer = replay
    cursor = replay.length
    requestRender()
    submit()
  }
  if (config.initialPrompt !== undefined && config.initialPrompt !== '') {
    buffer = config.initialPrompt
    cursor = buffer.length
    requestRender()
    submit()
  }
}
