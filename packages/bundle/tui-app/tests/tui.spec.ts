/** Interactive TUI driving: prompts, questions, approvals, commands, and exit. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { CallId, MessageId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { apply, internals } from '../src/index.ts'
import { VirtualTerminal } from '../src/terminal.ts'

const originalInternals = { ...internals }

afterEach(() => {
  Object.assign(internals, originalInternals)
})

/** Scripted assistant behavior: what a submitted prompt makes the session append. */
interface Script {
  afterPrompt?(session: Session, message: UserMessage): Promise<void> | void
}

/** Append one completed scripted turn: the prompt plus an assistant reply. */
function appendTurn(session: Session, turn: number, message: UserMessage, text: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Mount the real registries around a scripted Agent factory and boot the TUI on a virtual terminal. */
async function bench(script: Script, options: {
  loader?: { await(): Promise<void> }
  /** Optional service fakes provided before the runner applies. */
  extra?: (ctx: Context) => void
  /** Terminal width in columns (default 40). */
  width?: number
} = {}): Promise<{
  ctx: Context
  terminal: VirtualTerminal
  created: Promise<Agent>
  exitCode: Promise<number>
  stderr(): string
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(CommandRuntime)

  const terminal = new VirtualTerminal({ width: options.width ?? 40, height: 10 })
  internals.createTerminal = () => terminal
  let err = ''
  internals.stderr = { write: (chunk: string) => { err += chunk; return true } }

  if (options.loader !== undefined) ctx.provide('loader', options.loader)
  if (options.extra !== undefined) options.extra(ctx)
  let createdAgent!: (agent: Agent) => void
  const created = new Promise<Agent>((resolve) => { createdAgent = resolve })

  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      let idle = Promise.resolve()
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        status: 'idle',
        ctx: agentCtx,
        cancel: () => {},
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message: UserMessage) => {
          agent.inbox.append('next-turn', message)
          idle = Promise.resolve().then(() => script.afterPrompt?.(session, message))
        },
        steer: () => {},
        inject: () => {},
        whenIdle: () => idle,
      } satisfies Partial<Agent>)
      await options.setup?.(agentCtx)
      ctx.agents.register(agent)
      createdAgent(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('not used')),
  })

  const exitCode = new Promise<number>((resolve) => {
    ctx.provide('appExit', (code: number) => { resolve(code) })
  })
  apply(ctx, {})
  return { ctx, terminal, created, exitCode, stderr: () => err }
}

/** Flush microtasks and one timer tick so scheduled renders settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe('tui-runner', () => {
  it('streams the scripted reply into the transcript and exits cleanly on /exit', async () => {
    let prompted!: () => void
    const promptedSignal = new Promise<void>((resolve) => { prompted = resolve })
    const test = await bench({
      afterPrompt(session, message) {
        appendTurn(session, 1, message, 'hi back')
        prompted()
      },
    })
    await test.created
    await settle()
    test.terminal.feed('hello world\r')
    await promptedSignal
    await settle()
    expect(test.terminal.output).toContain('hi back')
    expect(test.terminal.output).toContain('hello world')
    test.terminal.feed('/exit\r')
    expect(await test.exitCode).toBe(0)
    await test.ctx.fiber.dispose()
    expect(test.terminal.restored).toBe(true)
    expect(test.stderr()).toBe('')
  })

  it('answers a single-select ask-user question with arrow keys and enter', async () => {
    const test = await bench({})
    const agent = await test.created
    const answerPromise = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'pick one', options: [{ label: 'one' }, { label: 'two' }] }],
      agent,
    })
    await settle()
    expect(test.terminal.output).toContain('pick one')
    test.terminal.feed('\x1b[B\r')
    expect(await answerPromise).toEqual({ answers: [{ id: 'q1', selected: ['two'] }] })
    await test.ctx.fiber.dispose()
  })

  it('toggles multi-select options with space and submits with enter', async () => {
    const test = await bench({})
    const agent = await test.created
    const answerPromise = test.ctx.userQuestions.ask({
      questions: [{
        id: 'q1',
        question: 'pick any',
        multiSelect: true,
        options: [{ label: 'one' }, { label: 'two' }, { label: 'three' }],
      }],
      agent,
    })
    await settle()
    test.terminal.feed(' \x1b[B \r')
    expect(await answerPromise).toEqual({ answers: [{ id: 'q1', selected: ['one', 'two'] }] })
    await test.ctx.fiber.dispose()
  })

  it('collects a free-text answer for a question without options', async () => {
    const test = await bench({})
    const agent = await test.created
    const answerPromise = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'what name?' }],
      agent,
    })
    await settle()
    expect(test.terminal.output).toContain('what name?')
    test.terminal.feed('ada\r')
    expect(await answerPromise).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'ada' }] })
    await test.ctx.fiber.dispose()
  })

  it('rejects the asker with ASK_ABORTED when the user escapes a question', async () => {
    const test = await bench({})
    const agent = await test.created
    const answerPromise = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'pick one', options: [{ label: 'one' }, { label: 'two' }] }],
      agent,
    })
    await settle()
    test.terminal.feed('\x1b')
    await expect(answerPromise).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await test.ctx.fiber.dispose()
  })

  it('allows an approval with enter and rejects with n', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    agent.session.append('turn/start', { turn: 1 })
    const allowed = test.ctx.approval.request({
      agent, toolName: 'bash', callId: CallId('call-1'), reason: 'writes files',
    })
    await settle()
    expect(test.terminal.output).toContain('Allow bash?')
    expect(test.terminal.output).toContain('writes files')
    test.terminal.feed('\r')
    expect(await allowed).toBe('allowed-once')

    agent.session.append('turn/start', { turn: 2 })
    const rejected = test.ctx.approval.request({ agent, toolName: 'bash' })
    await settle()
    test.terminal.feed('n')
    expect(await rejected).toBe('rejected')
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await test.ctx.fiber.dispose()
  })

  it('cancels an approval with escape', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    agent.session.append('turn/start', { turn: 1 })
    const pending = test.ctx.approval.request({ agent, toolName: 'bash' })
    await settle()
    test.terminal.feed('\x1b')
    expect(await pending).toBe('cancelled')
    await test.ctx.fiber.dispose()
  })

  it('delegates foreign approval requests down the waterfall', async () => {
    const test = await bench({})
    const agent = await test.created
    const foreign = { session: test.ctx.sessions.create(SessionId('other')) } as unknown as Agent
    const delegated: ApprovalOutcome[] = []
    test.ctx.on('approval/request', (_request, next) => next().then((outcome) => {
      delegated.push(outcome)
      return outcome
    }))
    const pending = test.ctx.waterfall('approval/request', {
      agent: foreign, toolName: 'bash',
    }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
    expect(await pending).toBe('unavailable')
    expect(delegated).toEqual(['unavailable'])
    void agent
    await test.ctx.fiber.dispose()
  })

  it('shows unknown commands as a notice and lists commands with /help', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.terminal.feed('/bogus\r')
    await settle()
    expect(test.terminal.output).toContain('unknown command: /bogus')
    test.terminal.feed('/help\r')
    await settle()
    // The help list wraps across the 40-column terminal; match the wrapped
    // fragments instead of the unwrapped line.
    expect(test.terminal.output).toContain('/exit — exit the terminal interface')
    expect(test.terminal.output).toContain('/help — list the commands available in')
    expect(test.terminal.output).toContain('this session')
    await test.ctx.fiber.dispose()
  })

  it('completes a slash command with an arrow-navigable popup and runs it', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.ctx.commands.register({
      name: 'zeta',
      description: 'sorts last',
      handler: () => ({ kind: 'success' as const }),
    })
    test.ctx.commands.register({
      name: 'alpha',
      description: 'sorts first',
      handler: () => ({ kind: 'success' as const }),
    })
    test.terminal.feed('/\t')
    await settle()
    // Sorted names: alpha, exit, help, zeta — the popup highlights the first.
    expect(test.terminal.output).toContain('› /alpha')
    test.terminal.feed('\x1b[B')
    await settle()
    expect(test.terminal.output).toContain('› /exit')
    test.terminal.feed('\t')
    await settle()
    expect(test.terminal.output).toContain('❯ /exit')
    test.terminal.feed('\r')
    expect(await test.exitCode).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('wraps the popup selection, closes with escape, and keeps history navigation', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.ctx.commands.register({
      name: 'alpha',
      description: 'sorts first',
      handler: () => ({ kind: 'success' as const }),
    })
    test.terminal.feed('/\t')
    await settle()
    expect(test.terminal.output).toContain('› /alpha')
    // Up from the first row wraps to the last: alpha, exit, help.
    test.terminal.feed('\x1b[A')
    await settle()
    expect(test.terminal.output).toContain('› /help')
    // Escape closes the popup but keeps the buffer.
    test.terminal.feed('\x1b')
    await settle()
    expect(test.terminal.output).toContain('❯ /')
    // With the popup closed, up and down navigate history (empty here).
    test.terminal.feed('\x1b[A\x1b[B')
    await settle()
    expect(test.terminal.output).toContain('❯ /')
    // A second escape clears the line.
    test.terminal.feed('\x1b')
    await settle()
    expect(test.terminal.output).toContain('❯ ask the agent — /help lists commands')
    await test.ctx.fiber.dispose()
  })

  it('accepts a unique match immediately and ignores unmatched prefixes', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.ctx.commands.register({
      name: 'alpha',
      description: 'the only al… command',
      handler: () => ({ kind: 'success' as const }),
    })
    test.terminal.feed('/al\t')
    await settle()
    expect(test.terminal.output).toContain('❯ /alpha')
    expect(test.terminal.output).not.toContain('› /')
    test.terminal.feed('\x15')
    test.terminal.feed('/zz\t')
    await settle()
    expect(test.terminal.output).toContain('❯ /zz')
    expect(test.terminal.output).not.toContain('› /')
    await test.ctx.fiber.dispose()
  })

  it('dismisses the popup on editing keys and indents non-command lines', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.ctx.commands.register({
      name: 'alpha',
      description: 'sorts first',
      handler: () => ({ kind: 'success' as const }),
    })
    test.terminal.feed('/\t')
    await settle()
    expect(test.terminal.output).toContain('› /alpha')
    // Typing edits the line, so the popup closes.
    test.terminal.feed('x')
    await settle()
    expect(test.terminal.output).toContain('❯ /x')
    test.terminal.feed('\x15')
    // Tab after a non-command line keeps its two-space indentation.
    test.terminal.feed('hi\t')
    await settle()
    expect(test.terminal.output).toContain('❯ hi  ')
    await test.ctx.fiber.dispose()
  })

  it('accepts the highlighted completion on enter without submitting', async () => {
    const test = await bench({})
    await test.created
    await settle()
    let ran = 0
    test.ctx.commands.register({
      name: 'alpha',
      description: 'counts its runs',
      handler: () => {
        ran += 1
        return { kind: 'success' as const }
      },
    })
    test.terminal.feed('/\t')
    await settle()
    // Enter accepts the highlighted command; a second enter runs it.
    test.terminal.feed('\r')
    await settle()
    expect(test.terminal.output).toContain('❯ /alpha')
    expect(ran).toBe(0)
    test.terminal.feed('\r')
    await settle()
    expect(ran).toBe(1)
    await test.ctx.fiber.dispose()
  })

  it('keeps command completion out of free-text question answers', async () => {
    const test = await bench({})
    const agent = await test.created
    const answerPromise = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'say anything' }],
      agent,
    })
    await settle()
    test.terminal.feed('/\t')
    await settle()
    expect(test.terminal.output).not.toContain('› /')
    expect(test.terminal.output).toContain('❯ /  ')
    test.terminal.feed('\r')
    expect(await answerPromise).toEqual({ answers: [{ id: 'q1', selected: [], custom: '/  ' }] })
    await test.ctx.fiber.dispose()
  })

  it('opens no popup before the agent exists', async () => {
    const test = await bench({})
    // Feed before the Agent finishes starting: completion has no registry view.
    test.terminal.feed('/\t')
    await settle()
    expect(test.terminal.output).not.toContain('› /')
    expect(test.terminal.output).toContain('❯ /')
    await test.created
    await test.ctx.fiber.dispose()
  })

  it('navigates and deletes by word with a kill ring and yank', async () => {
    const test = await bench({})
    await test.created
    await settle()
    // Prompt jumps with no user prompts in the transcript are no-ops.
    test.terminal.feed('\x1b[1;6A\x1b[1;6B')
    await settle()
    test.terminal.feed('one two three')
    await settle()
    expect(test.terminal.output).toContain('❯ one two three')
    // Yank with an empty ring and alt+y with no span are no-ops; so are
    // alt+d and ctrl+k at the line end, ctrl+u and ctrl+w at the start, and
    // an unknown alt character. ctrl+e restores the cursor to the end.
    test.terminal.feed('\x19\x1by\x1bd\x0b\x01\x15\x1bz\x17\x05')
    await settle()
    expect(test.terminal.output).toContain('❯ one two three')
    // ctrl+left, ctrl+right, alt+f, and alt+b move by word; the following
    // alt+d shows the landing spot.
    test.terminal.feed('\x1b[1;5D\x1b[1;5C\x1bf\x1bb')
    test.terminal.feed('\x1bd')
    await settle()
    expect(test.terminal.output).toContain('❯ one two ')
    // ctrl+y yanks the killed word back.
    test.terminal.feed('\x19')
    await settle()
    expect(test.terminal.output).toContain('❯ one two three')
    // A second kill ('four' word), then ctrl+k empties the line into the ring.
    test.terminal.feed('\x1b[1;5D\x1bdfour')
    await settle()
    expect(test.terminal.output).toContain('❯ one two four')
    test.terminal.feed('\x01\x0b')
    await settle()
    expect(test.terminal.output).toContain('❯ ask the agent — /help lists commands')
    // Yank restores the newest kill; alt+y rotates to the previous one.
    test.terminal.feed('\x19')
    await settle()
    expect(test.terminal.output).toContain('❯ one two four')
    test.terminal.feed('\x1by')
    await settle()
    expect(test.terminal.output).toContain('❯ three')
    // ctrl+u with the cursor at the end clears the line; a stale yank span
    // no longer matches, so alt+y stays a no-op.
    test.terminal.feed('\x15')
    await settle()
    expect(test.terminal.output).toContain('❯ ask the agent — /help lists commands')
    test.terminal.feed('\x1by')
    await settle()
    expect(test.terminal.output).toContain('❯ ask the agent — /help lists commands')
    // ctrl+u mid-line deletes to the start only.
    test.terminal.feed('abc\x01x\x15')
    await settle()
    expect(test.terminal.output).toContain('❯ abc')
    await test.ctx.fiber.dispose()
  })

  it('scrolls by line and half page and jumps between user prompts', async () => {
    let turn = 0
    const prompted: (() => void)[] = []
    const test = await bench({
      afterPrompt(session, message) {
        turn += 1
        const letter = turn === 1 ? 'a' : turn === 2 ? 'b' : turn === 3 ? 'c' : 'd'
        const reply = turn === 4 ? letter.repeat(270) : letter.repeat(90)
        appendTurn(session, turn, message, reply)
        prompted.shift()?.()
      },
    })
    await test.created
    const settleTurn = async (line: string): Promise<void> => {
      const done = new Promise<void>((resolve) => { prompted.push(resolve) })
      test.terminal.feed(`${line}\r`)
      await done
      await settle()
    }
    // Four turns: prompts are one row each and replies wrap to 3, 3, 3, and 7
    // rows (20 wrapped body rows against an 8-row viewport).
    await settleTurn('u1')
    await settleTurn('u2')
    await settleTurn('u3')
    await settleTurn('u4')
    // Bottom view: the fourth prompt sits at the top row.
    expect(test.terminal.output).toContain('\x1b[1;1H› u4\x1b[K')
    // alt+up scrolls one line up: the last row of the third reply.
    test.terminal.feed('\x1b[1;3A')
    await settle()
    expect(test.terminal.output).toContain(`\x1b[1;1H${'c'.repeat(10)}\x1b[K`)
    // alt+down returns to the bottom.
    test.terminal.feed('\x1b[1;3B')
    await settle()
    expect(test.terminal.output).toContain('\x1b[1;1H› u4\x1b[K')
    // ctrl+up scrolls half a page (3 rows): the third reply's first row.
    test.terminal.feed('\x1b[1;5A')
    await settle()
    expect(test.terminal.output).toContain(`\x1b[1;1H${'c'.repeat(40)}\x1b[K`)
    // ctrl+down scrolls half a page back to the bottom.
    test.terminal.feed('\x1b[1;5B')
    await settle()
    expect(test.terminal.output).toContain('\x1b[1;1H› u4\x1b[K')
    // ctrl+shift+up jumps prompt by prompt to the first one.
    test.terminal.feed('\x1b[1;6A')
    await settle()
    expect(test.terminal.output).toContain('\x1b[1;1H› u3\x1b[K')
    test.terminal.feed('\x1b[1;6A')
    await settle()
    expect(test.terminal.output).toContain('\x1b[1;1H› u2\x1b[K')
    test.terminal.feed('\x1b[1;6A')
    await settle()
    expect(test.terminal.output).toContain('\x1b[1;1H› u1\x1b[K')
    // ctrl+shift+up at the first prompt stays put.
    test.terminal.feed('\x1b[1;6A')
    await settle()
    expect(test.terminal.output).toContain('\x1b[1;1H› u1\x1b[K')
    // ctrl+shift+down walks forward; past the last prompt it rests at the bottom.
    test.terminal.feed('\x1b[1;6B')
    await settle()
    expect(test.terminal.output).toContain('\x1b[1;1H› u2\x1b[K')
    test.terminal.feed('\x1b[1;6B')
    await settle()
    expect(test.terminal.output).toContain('\x1b[1;1H› u3\x1b[K')
    test.terminal.feed('\x1b[1;6B\x1b[1;6B')
    await settle()
    expect(test.terminal.output).toContain('\x1b[1;1H› u4\x1b[K')
    await test.ctx.fiber.dispose()
  })

  it('shows the measured context tokens in the status bar', async () => {
    let totalTokens = 4321
    const test = await bench({}, {
      width: 80,
      extra: ctx => ctx.provide('tokenMeter', { measure: () => ({ totalTokens }) }),
    })
    const agent = await test.created
    await settle()
    expect(test.terminal.output).toContain('ready')
    const runTurn = (turn: number, tokens: number): void => {
      totalTokens = tokens
      appendTurn(agent.session, turn, createUserMessage({
        content: [{ type: 'text', text: `hi ${turn}` }],
        source: { kind: 'user' },
      }), 'reply')
    }
    runTurn(1, 4321)
    await settle()
    expect(test.terminal.output).toContain('ready · ctx 4.3k')
    runTurn(2, 123)
    await settle()
    expect(test.terminal.output).toContain('ready · ctx 123')
    runTurn(3, 15000)
    await settle()
    expect(test.terminal.output).toContain('ready · ctx 15k')
    await test.ctx.fiber.dispose()
  })

  it('renders tool diff cards through the tools bridge', async () => {
    let presented = 0
    const test = await bench({}, {
      extra: ctx => ctx.provide('tools', {
        get: (name: string) => name === 'edit'
          ? {
              presentCall: (args: unknown) => {
                presented += 1
                const path = (args as { path: string }).path
                return {
                  card: 'diff' as const,
                  title: `Edit ${path}`,
                  diffs: [{ path, oldText: 'x\n', newText: 'y\n' }],
                }
              },
              presentResult: (args: unknown) => {
                presented += 1
                const path = (args as { path: string }).path
                return {
                  card: 'diff' as const,
                  title: `Edited ${path}`,
                  diffs: [{ path, oldText: 'p\n', newText: 'q\n' }],
                }
              },
            }
          : undefined,
      }),
    })
    const agent = await test.created
    await settle()
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('c1'), name: 'edit', arguments: '{"path":"a.ts"}',
    })
    await settle()
    expect(test.terminal.output).toContain('Edit a.ts')
    expect(test.terminal.output).toContain('- x')
    expect(test.terminal.output).toContain('+ y')
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        id: MessageId('r1'),
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'done' }] }],
        source: { kind: 'tool', callId: CallId('c1') },
      },
    }, { surfaceOp: 'append' })
    await settle()
    expect(test.terminal.output).toContain('Edited a.ts')
    expect(test.terminal.output).toContain('- p')
    expect(test.terminal.output).toContain('+ q')
    expect(presented).toBe(2)
    await test.ctx.fiber.dispose()
  })

  it('submits the initial prompt positional automatically', async () => {
    let prompted!: () => void
    const promptedSignal = new Promise<void>((resolve) => { prompted = resolve })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(CommandRuntime)
    const terminal = new VirtualTerminal({ width: 40, height: 10 })
    internals.createTerminal = () => terminal
    internals.stderr = { write: () => true }
    ctx.agents.setFactory({
      async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
        const session = ctx.sessions.create(options.sessionId)
        let idle = Promise.resolve()
        const agent = {} as Agent
        const agentCtx = ownerCtx.extend({ agent })
        Object.assign(agent, {
          id: session.id,
          options: options.agentOptions ?? {},
          session,
          inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
          status: 'idle',
          ctx: agentCtx,
          cancel: () => {},
          runMaintenance: () => Promise.reject(new Error('not used')),
          send: () => {},
          followup: (message: UserMessage) => {
            agent.inbox.append('next-turn', message)
            idle = Promise.resolve().then(() => {
              appendTurn(session, 1, message, 'ran it')
              prompted()
            })
          },
          steer: () => {},
          inject: () => {},
          whenIdle: () => idle,
        } satisfies Partial<Agent>)
        await options.setup?.(agentCtx)
        ctx.agents.register(agent)
        return { agent, dispose: () => Promise.resolve() }
      },
      resume: () => Promise.reject(new Error('not used')),
    })
    ctx.provide('appExit', () => {})
    apply(ctx, { initialPrompt: 'do the thing' })
    await promptedSignal
    await settle()
    expect(terminal.output).toContain('ran it')
    expect(terminal.output).toContain('do the thing')
    await ctx.fiber.dispose()
  })

  it('cancels the running turn with ctrl-c and exits with ctrl-d when idle', async () => {
    const test = await bench({
      afterPrompt: async (session, message) => {
        session.append('turn/start', { turn: 1 })
        await new Promise(resolve => setTimeout(resolve, 200))
        session.append('turn/end', {
          turn: 1,
          reason: { kind: 'aborted', reason: { kind: 'user' } },
        })
        void message
      },
    })
    await test.created
    await settle()
    test.terminal.feed('work now\r')
    await settle()
    test.terminal.feed('\x03') // ctrl-c while busy: cancel + notice
    await settle()
    expect(test.terminal.output).toContain('interrupted')
    test.terminal.feed('\x04') // ctrl-d when idle: exit 0
    expect(await test.exitCode).toBe(0)
    await test.ctx.fiber.dispose()
    expect(test.terminal.restored).toBe(true)
  })

  it('fails loud when the process has no interactive terminal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
    let err = ''
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    // The real factory creates a terminal from the real TTY; substituting a
    // throwing factory exercises the failure path without a PTY.
    internals.createTerminal = () => { throw new Error('dsh tui needs an interactive terminal; use "dsh --profile headless <task>" for pipes and scripts') }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', (code: number) => { resolve(code) })
    })
    apply(ctx, {})
    expect(await exited).toBe(1)
    expect(err).toContain('dsh tui needs an interactive terminal')
    await ctx.fiber.dispose()
  })

  it('fails loud without the launcher-provided exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, {}) }).toThrow('must provide ctx.appExit')
  })
})

describe('tui-runner editing and lifecycle', () => {
  /** Capture every prompt the agent actually received. */
  async function submittedBench(): Promise<{ received: string[]; test: Awaited<ReturnType<typeof bench>> }> {
    const received: string[] = []
    const test = await bench({
      afterPrompt: (_session, message) => {
        received.push(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      },
    })
    return { received, test }
  }

  it('edits the buffer with arrows, deletion, and control keys', async () => {
    const { received, test } = await submittedBench()
    await test.created
    await settle()
    // Type "ab cd", then: home, right, delete (removes 'b'), ctrl-e, backspace,
    // ctrl-a, ctrl-e, ctrl-w (drops the trailing word), ctrl-u would clear —
    // keep a submit at each step and assert the received text.
    test.terminal.feed('ab cd\r')
    await settle()
    expect(received[0]).toBe('ab cd')
    test.terminal.feed('xy z')
    test.terminal.feed('\x01') // ctrl-a
    test.terminal.feed('\x1b[C') // right
    test.terminal.feed('\x7f') // backspace removes 'x'
    test.terminal.feed('\x05') // ctrl-e
    test.terminal.feed('\x15') // ctrl-u clears
    test.terminal.feed('keep')
    test.terminal.feed('\x17') // ctrl-w deletes 'keep'
    test.terminal.feed('done\r')
    await settle()
    expect(received[1]).toBe('done')
    test.terminal.feed('ab')
    test.terminal.feed('\x04') // ctrl-d deletes forward at the end: no-op
    test.terminal.feed('\x1b[D') // left
    test.terminal.feed('\x1b[3~') // delete removes 'b'
    test.terminal.feed('\x1b[1~') // home
    test.terminal.feed('\x1b[4~') // end
    test.terminal.feed('\r')
    await settle()
    expect(received[2]).toBe('a')
    await test.ctx.fiber.dispose()
  })

  it('navigates history with up, down, ctrl-n, and ctrl-p', async () => {
    const { received, test } = await submittedBench()
    await test.created
    await settle()
    test.terminal.feed('first\r')
    await settle()
    test.terminal.feed('second\r')
    await settle()
    test.terminal.feed('\x1b[A\r') // up recalls "second"
    await settle()
    expect(received[2]).toBe('second')
    test.terminal.feed('\x1b[A\x1b[A') // up twice: "first"
    test.terminal.feed('\x1b[B') // down once: "second"
    test.terminal.feed('\r')
    await settle()
    expect(received[3]).toBe('second')
    test.terminal.feed('\x10\r') // ctrl-p: "second"
    await settle()
    expect(received[4]).toBe('second')
    test.terminal.feed('\x0e') // ctrl-n back to the draft, then type fresh text
    test.terminal.feed('third\r')
    await settle()
    expect(received[5]).toBe('third')
    void received
    await test.ctx.fiber.dispose()
  })

  it('clears a non-empty buffer with ctrl-c and escape', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.terminal.feed('abc\x03') // ctrl-c clears
    await settle()
    expect(test.terminal.output).toContain('❯ ask the agent — /help lists commands')
    test.terminal.feed('x\x1b') // escape clears
    await settle()
    expect(test.terminal.output).toContain('❯ ask the agent — /help lists commands')
    await test.ctx.fiber.dispose()
  })

  it('holds a prompt submitted before the agent exists and replays it', async () => {
    const { received, test } = await submittedBench()
    test.terminal.feed('early bird\r') // typed before the agent exists
    await test.created
    await settle()
    expect(received[0]).toBe('early bird')
    await test.ctx.fiber.dispose()
  })

  it('answers a multi-question request sequentially, mixing menus and free text', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const answerPromise = test.ctx.userQuestions.ask({
      questions: [
        {
          id: 'q1',
          header: 'group',
          question: 'pick one',
          detail: 'more context',
          options: [{ label: 'one' }, { label: 'two' }],
        },
        { id: 'q2', question: 'what name?' },
      ],
      agent,
    })
    await settle()
    expect(test.terminal.output).toContain('group: pick one')
    expect(test.terminal.output).toContain('more context')
    test.terminal.feed('\r')
    await settle()
    expect(test.terminal.output).toContain('what name?')
    test.terminal.feed('x')
    test.terminal.feed('\x7f') // backspace in the free-text answer
    test.terminal.feed('ada\r')
    expect(await answerPromise).toEqual({
      answers: [
        { id: 'q1', selected: ['one'] },
        { id: 'q2', selected: [], custom: 'ada' },
      ],
    })
    await test.ctx.fiber.dispose()
  })

  it('clamps question selection at both ends', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const first = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'pick one', options: [{ label: 'one' }, { label: 'two' }] }],
      agent,
    })
    await settle()
    test.terminal.feed('\x1b[A\x1b[A') // up at the top stays at "one"
    test.terminal.feed('\r')
    expect(await first).toEqual({ answers: [{ id: 'q1', selected: ['one'] }] })
    const second = test.ctx.userQuestions.ask({
      questions: [{ id: 'q2', question: 'pick one', options: [{ label: 'one' }, { label: 'two' }] }],
      agent,
    })
    await settle()
    test.terminal.feed('\x1b[B\x1b[B\x1b[B') // down past the bottom stays at "two"
    test.terminal.feed('\r')
    expect(await second).toEqual({ answers: [{ id: 'q2', selected: ['two'] }] })
    await test.ctx.fiber.dispose()
  })

  it('withdraws a queued question when its signal aborts', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const first = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'first?', options: [{ label: 'a' }, { label: 'b' }] }],
      agent,
    })
    await settle()
    const abort = new AbortController()
    const second = test.ctx.userQuestions.ask({
      questions: [{ id: 'q2', question: 'second?', options: [{ label: 'x' }] }],
      agent,
      signal: abort.signal,
    })
    await settle()
    abort.abort()
    await expect(second).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    // The first question is still active and answerable.
    test.terminal.feed('\r')
    expect(await first).toEqual({ answers: [{ id: 'q1', selected: ['a'] }] })
    await test.ctx.fiber.dispose()
  })

  it('settles a queued approval as cancelled when its signal aborts', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const question = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'busy?', options: [{ label: 'yes' }, { label: 'no' }] }],
      agent,
    })
    await settle()
    agent.session.append('turn/start', { turn: 1 })
    const abort = new AbortController()
    const approval = test.ctx.approval.request({
      agent, toolName: 'bash', signal: abort.signal,
    })
    await settle()
    abort.abort()
    expect(await approval).toBe('cancelled')
    test.terminal.feed('\r')
    expect(await question).toEqual({ answers: [{ id: 'q1', selected: ['yes'] }] })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await test.ctx.fiber.dispose()
  })

  it('answers an already-aborted approval request with cancelled', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const abort = new AbortController()
    abort.abort()
    const outcome = test.ctx.waterfall('approval/request', {
      agent, toolName: 'bash', signal: abort.signal,
    }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
    expect(await outcome).toBe('cancelled')
    await test.ctx.fiber.dispose()
  })

  it('rejects approvals with left/enter and toggles with tab', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    agent.session.append('turn/start', { turn: 1 })
    const first = test.ctx.approval.request({ agent, toolName: 'bash' })
    await settle()
    test.terminal.feed('\x1b[D\r') // left + enter: reject
    expect(await first).toBe('rejected')
    agent.session.append('turn/start', { turn: 2 })
    const second = test.ctx.approval.request({ agent, toolName: 'bash' })
    await settle()
    test.terminal.feed('\t') // tab toggles to reject
    test.terminal.feed('\t') // and back to allow
    test.terminal.feed('\r')
    expect(await second).toBe('allowed-once')
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await test.ctx.fiber.dispose()
  })

  it('renders turn errors and injected context notes', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', {
      role: 'user',
      id: MessageId('m1'),
      content: [{ type: 'text', text: 'injected note' }],
      source: { kind: 'plugin', plugin: 'x' },
    }, { surfaceOp: 'append' })
    agent.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'SERVER', message: 'provider down' } },
    })
    await settle()
    expect(test.terminal.output).toContain('injected note')
    expect(test.terminal.output).toContain('SERVER: provider down')
    await test.ctx.fiber.dispose()
  })

  it('ignores events from other sessions', async () => {
    const test = await bench({})
    await test.created
    await settle()
    const foreign = test.ctx.sessions.create(SessionId('foreign'))
    foreign.append('user/message', {
      role: 'user',
      id: MessageId('m1'),
      content: [{ type: 'text', text: 'foreign text' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    await settle()
    expect(test.terminal.output).not.toContain('foreign text')
    await test.ctx.fiber.dispose()
  })

  it('scrolls the transcript with page keys and repaints fully with ctrl-l', async () => {
    const test = await bench({
      afterPrompt: (session) => {
        for (let index = 0; index < 30; index++) {
          session.append('assistant/message', {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: 'text', text: `line ${index}` }],
              source: { provider: 'test-provider', model: 'test-model' },
            }),
          }, { surfaceOp: 'append' })
        }
      },
    })
    await test.created
    await settle()
    test.terminal.feed('go\r')
    await settle()
    const topRows = (): string[] => [...test.terminal.output.matchAll(/\x1b\[1;1H([^\x1b]*)\x1b\[K/gu)].map(match => match[1] ?? '')
    expect(topRows().at(-1)).toBe('line 22')
    test.terminal.feed('\x1b[5~') // page-up
    await settle()
    expect(topRows().at(-1)).toBe('line 16')
    test.terminal.feed('\x0c') // ctrl-l repaints from scratch
    await settle()
    expect(topRows().at(-1)).toBe('line 16')
    test.terminal.feed('\x1b[6~\x1b[6~') // page-down twice, back to the bottom
    await settle()
    expect(topRows().at(-1)).toBe('line 22')
    await test.ctx.fiber.dispose()
  })

  it('warns instead of failing when the post-turn flush rejects', async () => {
    const test = await bench({
      afterPrompt: (session, message) => { appendTurn(session, 1, message, 'done') },
    })
    await test.created
    await settle()
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk gone'))
    const warn = vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
    test.terminal.feed('go\r')
    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session flush failed'))
    flush.mockRestore()
    warn.mockRestore()
    await test.ctx.fiber.dispose()
  })

  it('re-renders on resize and exits on input close', async () => {
    const test = await bench({})
    await test.created
    await settle()
    const before = test.terminal.output.length
    test.terminal.setSize(30, 8)
    await settle()
    expect(test.terminal.output.length).toBeGreaterThan(before)
    test.terminal.close()
    expect(await test.exitCode).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('ignores keys after exit', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.terminal.feed('/exit\r')
    expect(await test.exitCode).toBe(0)
    const before = test.terminal.output.length
    test.terminal.feed('post exit\r')
    await settle()
    expect(test.terminal.output.length).toBe(before)
    await test.ctx.fiber.dispose()
  })

  it('runs an error-result command into the transcript', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.ctx.commands.register({
      name: 'boom',
      description: 'fails on purpose',
      handler: () => ({ kind: 'error' as const, text: 'kaboom' }),
    })
    test.terminal.feed('/boom\r')
    await settle()
    expect(test.terminal.output).toContain('kaboom')
    await test.ctx.fiber.dispose()
  })

  it('shows a thrown command handler as a transcript error', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.ctx.commands.register({
      name: 'thrower',
      description: 'throws on purpose',
      handler: () => { throw new Error('handler exploded') },
    })
    test.terminal.feed('/thrower\r')
    await settle()
    expect(test.terminal.output).toContain('handler exploded')
    await test.ctx.fiber.dispose()
  })

  it('sends slash lines to the model when no command runtime is composed', async () => {
    const received: string[] = []
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
    const terminal = new VirtualTerminal({ width: 40, height: 10 })
    internals.createTerminal = () => terminal
    internals.stderr = { write: () => true }
    ctx.agents.setFactory({
      async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
        const session = ctx.sessions.create(options.sessionId)
        let idle = Promise.resolve()
        const agent = {} as Agent
        const agentCtx = ownerCtx.extend({ agent })
        Object.assign(agent, {
          id: session.id,
          options: options.agentOptions ?? {},
          session,
          inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
          status: 'idle',
          ctx: agentCtx,
          cancel: () => {},
          runMaintenance: () => Promise.reject(new Error('not used')),
          send: () => {},
          followup: (message: UserMessage) => {
            agent.inbox.append('next-turn', message)
            idle = Promise.resolve().then(() => {
              received.push(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
            })
          },
          steer: () => {},
          inject: () => {},
          whenIdle: () => idle,
        } satisfies Partial<Agent>)
        await options.setup?.(agentCtx)
        ctx.agents.register(agent)
        return { agent, dispose: () => Promise.resolve() }
      },
      resume: () => Promise.reject(new Error('not used')),
    })
    ctx.provide('appExit', () => {})
    apply(ctx, {})
    await settle()
    // No command runtime: tab opens no popup and leaves the slash untouched.
    terminal.feed('/\t')
    await settle()
    expect(terminal.output).not.toContain('› /')
    terminal.feed('\x15')
    terminal.feed('/goal do it\r')
    await settle()
    expect(received).toEqual(['/goal do it'])
    await ctx.fiber.dispose()
  })

  it('returns early when the core services are absent', async () => {
    const ctx = new Context()
    let exited = false
    ctx.provide('appExit', () => { exited = true })
    apply(ctx, {})
    await settle()
    expect(exited).toBe(false)
    await ctx.fiber.dispose()
  })

  it('reports a non-Error failure on stderr and exits 1', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
    let err = ''
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    internals.createTerminal = () => { throw 'boom' }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', (code: number) => { resolve(code) })
    })
    apply(ctx, {})
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: boom\n')
    await ctx.fiber.dispose()
  })

  it('waits for loader settlement before creating the agent', async () => {
    let created = false
    const release: { settle?: () => void } = {}
    const settlement = new Promise<void>((resolve) => { release.settle = resolve })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(CommandRuntime)
    const terminal = new VirtualTerminal({ width: 40, height: 10 })
    internals.createTerminal = () => terminal
    internals.stderr = { write: () => true }
    ctx.agents.setFactory({
      async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
        created = true
        const session = ctx.sessions.create(options.sessionId)
        let idle = Promise.resolve()
        const agent = {} as Agent
        const agentCtx = ownerCtx.extend({ agent })
        Object.assign(agent, {
          id: session.id,
          options: options.agentOptions ?? {},
          session,
          inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
          status: 'idle',
          ctx: agentCtx,
          cancel: () => {},
          runMaintenance: () => Promise.reject(new Error('not used')),
          send: () => {},
          followup: () => {},
          steer: () => {},
          inject: () => {},
          whenIdle: () => idle,
        } satisfies Partial<Agent>)
        await options.setup?.(agentCtx)
        ctx.agents.register(agent)
        return { agent, dispose: () => Promise.resolve() }
      },
      resume: () => Promise.reject(new Error('not used')),
    })
    ctx.provide('appExit', () => {})
    ctx.provide('loader', { await: () => settlement })
    apply(ctx, {})
    await settle()
    expect(created).toBe(false)
    release.settle!()
    await settle()
    expect(created).toBe(true)
    await ctx.fiber.dispose()
  })
})

describe('tui-runner remaining interaction branches', () => {
  it('exits via ctrl-d before the agent exists', async () => {
    const test = await bench({})
    test.terminal.feed('\x04')
    expect(await test.exitCode).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('ignores a second exit request', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.terminal.feed('/exit\r')
    expect(await test.exitCode).toBe(0)
    test.terminal.close() // second request: the exited guard returns
    await settle()
    await test.ctx.fiber.dispose()
  })

  it('withdraws a question twice without error', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const abort = new AbortController()
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'pick?', options: [{ label: 'a' }] }],
      agent,
      signal: abort.signal,
    })
    await settle()
    abort.abort()
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await test.ctx.fiber.dispose()
  })

  it('settles an approval twice without error', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    agent.session.append('turn/start', { turn: 1 })
    const abort = new AbortController()
    const pending = test.ctx.approval.request({ agent, toolName: 'bash', signal: abort.signal })
    await settle()
    abort.abort()
    abort.abort()
    expect(await pending).toBe('cancelled')
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await test.ctx.fiber.dispose()
  })

  it('ignores backspace at the start of the buffer and inserts tabs', async () => {
    const received: string[] = []
    const test = await bench({
      afterPrompt: (_session, message) => {
        received.push(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      },
    })
    await test.created
    await settle()
    test.terminal.feed('\x7f') // backspace at cursor 0: no-op
    test.terminal.feed('a\tb') // tab inserts two spaces
    test.terminal.feed('\r')
    await settle()
    expect(received[0]).toBe('a  b')
    await test.ctx.fiber.dispose()
  })

  it('deletes trailing spaces before the word with ctrl-w', async () => {
    const received: string[] = []
    const test = await bench({
      afterPrompt: (_session, message) => {
        received.push(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      },
    })
    await test.created
    await settle()
    test.terminal.feed('a b   ')
    test.terminal.feed('\x17') // emacs-style: drops trailing spaces and "b"
    test.terminal.feed('\r')
    await settle()
    expect(received[0]).toBe('a')
    await test.ctx.fiber.dispose()
  })

  it('treats ctrl-c on an idle empty buffer as exit and ignores unknown ctrl letters', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.terminal.feed('\x02') // ctrl-b: no-op
    test.terminal.feed('\x03') // ctrl-c idle empty: exit 0
    expect(await test.exitCode).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('ignores enter on an empty buffer', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.terminal.feed('\r')
    await settle()
    test.terminal.feed('/exit\r')
    expect(await test.exitCode).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('stringifies a non-Error command handler failure', async () => {
    const test = await bench({})
    await test.created
    await settle()
    test.ctx.commands.register({
      name: 'stringthrow',
      description: 'throws a string',
      handler: () => { throw 'plain string failure' },
    })
    test.terminal.feed('/stringthrow\r')
    await settle()
    expect(test.terminal.output).toContain('plain string failure')
    await test.ctx.fiber.dispose()
  })

  it('ignores unhandled key kinds inside question and confirm widgets', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'pick?', options: [{ label: 'a' }, { label: 'b' }] }],
      agent,
    })
    await settle()
    test.terminal.feed('\x1b[D') // left in question mode: default no-op
    test.terminal.feed('\r')
    expect(await pending).toEqual({ answers: [{ id: 'q1', selected: ['a'] }] })

    agent.session.append('turn/start', { turn: 1 })
    const approval = test.ctx.approval.request({ agent, toolName: 'bash' })
    await settle()
    test.terminal.feed('\x1b[A') // up in confirm mode: default no-op
    test.terminal.feed('x') // a non-y/n char: no-op
    test.terminal.feed('Y') // capital Y allows
    expect(await approval).toBe('allowed-once')
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await test.ctx.fiber.dispose()
  })

  it('cancels a running turn with ctrl-c while busy', async () => {
    const test = await bench({
      afterPrompt: async (session, message) => {
        session.append('turn/start', { turn: 1 })
        await new Promise(resolve => setTimeout(resolve, 200))
        // The scripted agent swallows the cancel; the turn completes anyway,
        // so "interrupted" can only come from the ctrl-c notice.
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        void message
      },
    })
    await test.created
    await settle()
    test.terminal.feed('work\r')
    await settle()
    test.terminal.feed('\x03')
    await settle()
    expect(test.terminal.output).toContain('interrupted')
    await settle()
    await test.ctx.fiber.dispose()
  })
})

describe('tui-runner final interaction branches', () => {
  it('warns when the exit flush rejects', async () => {
    const test = await bench({})
    await test.created
    await settle()
    const warn = vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(test.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk gone'))
    test.terminal.feed('/exit\r')
    expect(await test.exitCode).toBe(0)
    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session flush failed'))
    warn.mockRestore()
    await test.ctx.fiber.dispose()
  })

  it('aborts a question after its answer settled it', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const abort = new AbortController()
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'pick?', options: [{ label: 'a' }, { label: 'b' }] }],
      agent,
      signal: abort.signal,
    })
    await settle()
    test.terminal.feed('\r')
    expect(await pending).toEqual({ answers: [{ id: 'q1', selected: ['a'] }] })
    abort.abort() // late abort: the settled question is already gone
    await settle()
    await test.ctx.fiber.dispose()
  })

  it('aborts an approval after a key already settled it', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    agent.session.append('turn/start', { turn: 1 })
    const abort = new AbortController()
    const pending = test.ctx.approval.request({ agent, toolName: 'bash', signal: abort.signal })
    await settle()
    test.terminal.feed('y')
    expect(await pending).toBe('allowed-once')
    abort.abort() // late abort: the settled confirm is already gone
    await settle()
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await test.ctx.fiber.dispose()
  })

  it('escapes a free-text question', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'what name?' }],
      agent,
    })
    await settle()
    test.terminal.feed('ada\x1b')
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await test.ctx.fiber.dispose()
  })

  it('untoggles a multi-select option and ignores other characters', async () => {
    const test = await bench({})
    const agent = await test.created
    await settle()
    const pending = test.ctx.userQuestions.ask({
      questions: [{
        id: 'q1',
        question: 'pick any',
        multiSelect: true,
        options: [{ label: 'one' }, { label: 'two' }],
      }],
      agent,
    })
    await settle()
    test.terminal.feed(' ') // toggle "one" on
    test.terminal.feed('x') // ignored in a multi-select menu
    test.terminal.feed(' ') // toggle "one" off again
    test.terminal.feed('\r')
    expect(await pending).toEqual({ answers: [{ id: 'q1', selected: [] }] })
    await test.ctx.fiber.dispose()
  })

  it('keeps the viewport pinned while scrolled up', async () => {
    let liveSession: Session | undefined
    const test = await bench({
      afterPrompt: (session) => {
        liveSession = session
        for (let index = 0; index < 30; index++) {
          session.append('assistant/message', {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: 'text', text: `line ${index}` }],
              source: { provider: 'test-provider', model: 'test-model' },
            }),
          }, { surfaceOp: 'append' })
        }
      },
    })
    await test.created
    await settle()
    test.terminal.feed('go\r')
    await settle()
    const topRows = (): string[] => [...test.terminal.output.matchAll(/\x1b\[1;1H([^\x1b]*)\x1b\[K/gu)].map(match => match[1] ?? '')
    test.terminal.feed('\x1b[5~') // page-up: top becomes line 16
    await settle()
    expect(topRows().at(-1)).toBe('line 16')
    // New records keep the pinned viewport: offset advances with the log.
    liveSession?.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'line 30' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    await settle()
    expect(topRows().at(-1)).toBe('line 16')
    // A record-less event (turn marker) leaves the offset alone.
    liveSession?.append('turn/start', { turn: 2 })
    liveSession?.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await settle()
    expect(topRows().at(-1)).toBe('line 16')
    await test.ctx.fiber.dispose()
  })
})
