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
import type { Key } from './keys.ts'
import { composeFrame, diffFrames, type Frame, type FrameInput } from './render.ts'
import { createTtyTerminal, type TerminalDriver, type TtyInput, type TtyOutput } from './terminal.ts'
import { Transcript } from './transcript.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the invocation resolved from this app's injected provider service. */
export interface Config {
  /** The optional first prompt, submitted as soon as the TUI is ready. */
  initialPrompt?: string
}

export const Config: z<Config> = z.object({
  initialPrompt: z.string().default(''),
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
  void run(ctx, config.initialPrompt, io, exit, held).catch((error: unknown) => { fail(io, exit, error) })
}

/**
 * Boot the TUI: settle the Loader, create one Agent, drive the terminal.
 * @param ctx - plugin context.
 * @param initialPrompt - the optional first prompt, submitted once the interface is ready.
 * @param io - process-facing effects.
 * @param exit - the launcher's bounded exit request.
 * @param held - terminal holder for the fiber-disposal restore.
 */
async function run(
  ctx: Context, initialPrompt: string | undefined, io: TuiIo, exit: (code: number) => void, held: { terminal?: TerminalDriver },
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

  const transcript = new Transcript()
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

  /** Paint one frame; the diff only rewrites changed rows. */
  function render(): void {
    const input: FrameInput = {
      body: transcript.lines(),
      bodyOffset,
      status: {
        left: `${selection.provider} ${selection.model}`,
        right: busy ? `turn ${turn}` : 'ready',
        busy,
        spinner: renderCount,
      },
    }
    if (notice !== undefined) input.notice = notice
    if (current?.kind === 'question') {
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

  /** Delete trailing whitespace and the word before the cursor (ctrl-w). */
  function deleteWord(): void {
    let end = cursor
    while (end > 0 && buffer[end - 1]! === ' ') end -= 1
    while (end > 0 && buffer[end - 1]! !== ' ') end -= 1
    buffer = buffer.slice(0, end) + buffer.slice(cursor)
    cursor = end
    requestRender()
  }

  /** Scroll the transcript viewport by one page. */
  function scroll(direction: 1 | -1): void {
    const page = Math.max(1, terminal.height - 4)
    bodyOffset = direction === 1 ? bodyOffset + page : Math.max(0, bodyOffset - page)
    requestRender()
  }

  /** Shared single-line editing keys (input mode and free-text questions). */
  function handleEditorKey(key: Key, actions: { submit: () => void; escape: () => void }): void {
    switch (key.kind) {
      case 'char':
        insertChar(key.char)
        break
      case 'enter':
        actions.submit()
        break
      case 'backspace':
        backspace()
        break
      case 'delete':
        deleteForward()
        break
      case 'left':
        cursor = Math.max(0, cursor - 1)
        requestRender()
        break
      case 'right':
        cursor = Math.min(buffer.length, cursor + 1)
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
      case 'up':
        buffer = history.navigate(1, buffer)
        cursor = buffer.length
        requestRender()
        break
      case 'down':
        buffer = history.navigate(-1, buffer)
        cursor = buffer.length
        requestRender()
        break
      case 'tab':
        insertChar('  ')
        break
      case 'escape':
        actions.escape()
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
            buffer = ''
            cursor = 0
            requestRender()
            break
          case 'w':
            deleteWord()
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
    })
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
      })
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
    }
    transcript.consume(event)
    const added = transcript.view().length - before
    // A scrolled-up reader stays pinned to the same content.
    if (bodyOffset > 0 && added > 0) bodyOffset += added
    requestRender()
  })

  const offKey = terminal.onKey((key: Key) => {
    if (exited) return
    const pending = current
    if (pending?.kind === 'confirm') handleConfirmKey(key, pending)
    else if (pending?.kind === 'question') handleQuestionKey(key, pending)
    else handleInputKey(key)
  })
  const offResize = terminal.onResize(() => { requestRender() })
  terminal.onClose(() => { requestExit(0) })
  ctx.effect(() => () => { offKey(); offResize() })

  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  myAgent = agent
  sessionRef = agent.session

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
  if (initialPrompt !== undefined && initialPrompt !== '') {
    buffer = initialPrompt
    cursor = buffer.length
    requestRender()
    submit()
  }
}
