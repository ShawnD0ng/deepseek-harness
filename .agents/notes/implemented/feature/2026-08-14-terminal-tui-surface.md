# Agent Note: The dsh tui terminal surface

Status: implemented

English | [中文](2026-08-14-terminal-tui-surface.zh.md)

## Problem

dsh had a browser interface and a one-shot headless runner, but no interactive terminal experience: a user who wants a Claude-Code-style conversation in their terminal must either run the browser app or script repeated headless invocations. The harness already carries every interaction capability the terminal surface needs (session event firehose, ask-user provider seam, approval waterfall, slash-command runtime), so the gap is a presentation surface, not new core machinery.

## Decision

`@deepseek-ai/dsh-tui-app` is a new profile bundle over `dsh-base`, mirroring `dsh-headless`: `cordis.patch.yml` supplies the persona, disables the shared HMR row, mounts Code Mode's worker, and inserts the `tui-startup` provider plus the `tui-runner` plugin. The launcher gains the `tui` profile template (`dsh-base` + `dsh-tui-app`) and the `dsh tui` alias beside `dsh web`.

The runner creates one persisted Agent through `ctx.agents`, folds its `session/event` firehose into a bounded transcript, and drives a full-screen interface over the process TTY. The terminal layer is hand-rolled and deterministic: a wcwidth display-width table, an escape-sequence keystroke parser with bracketed-paste support, a pure frame composer plus row-diff renderer, and a driver seam whose production half owns raw mode, the alternate screen, resize, and restore (including pausing stdin so the event loop drains after exit). `NO_COLOR` disables styling; `TERM=dumb` or non-TTY stdio fails loud with a pointer to the headless profile.

Interactions reuse the harness seams: the runner registers the active `userQuestions` provider (in-line menus, multi-select toggles, free-text answers, all abortable), answers `approval/request` for its own Agent (delegating foreign requests down the waterfall), and registers `/exit` and `/help` through `ctx.commands`, so composed commands such as `/compact` and `/goal` work without TUI-specific code. Tab completes the leading command name from the shared registry (`commands.list`) while the line is still a pure command prefix: a lone match fills the line directly, several matches open a popup that `↑`/`↓` navigates, Tab or Enter accepts, and Esc or any editing key closes it; the same registry feeds `/help`. Slash lines, ask-user questions, and approvals share one interaction queue, so a question never races a pending approval for the keyboard. The optional initial prompt positional (`dsh tui "run the tests"`) submits once the interface is ready; prompts typed before the Agent exists queue for replay.

## Alternatives considered

**Ink (or blessed) as the rendering framework** — rejected. Ink deletes the layout and input-handling code but adds a React runtime, an asynchronous render loop, and testing-library indirection to a surface whose output must be byte-deterministic for the repository's snapshot-style gates; the hand-rolled renderer is pure and synchronous, so unit tests compare exact frames and the PTY e2e asserts exact control sequences.

**ACP client attached to a separately running server** — rejected. The natural invocation is one command that boots everything (`dsh tui`), like the headless and web surfaces; an extra long-lived server process adds orchestration without removing any of this bundle's code.

**Terminal session reuse (`dsh-terminal`) for the UI pane** — rejected. That package emulates terminals for the agent's own tools; the TUI needs a tiny, controllable terminal abstraction, not a terminal-emulator protocol, and the driver seam already keeps the real TTY behind an interface.

## Consequences

The terminal surface depends on the existing interaction seams only, so a custom composition without `dsh-user-questions`, `dsh-user-approval`, or `dsh-commands` still boots and degrades to a plain chat loop. The renderer's wcwidth approximation (East Asian Ambiguous width 1, emoji ZWJ sequences as the sum of parts) misaligns unusual glyphs; the package README records this and the other deferred work (session resume, multi-line input, persistent history).

## Verification

The unit suite covers width arithmetic, keystroke decoding, frame composition and diffing, completion, history, the transcript projection, and the full interaction matrix on a `VirtualTerminal` (prompts, commands, questions, approvals, cancellation, scroll pinning, exit paths) at 100% per-file coverage. `apps/cli/tests/tui-pty.e2e.ts` boots the real `dsh tui` profile tree in a PTY against the mock LLM server: it types a prompt, observes the streamed reply and the spinner, opens the slash-completion popup, sends `/exit`, and asserts a clean exit with the alternate screen restored.
