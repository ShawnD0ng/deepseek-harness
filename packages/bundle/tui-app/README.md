# `@deepseek-ai/dsh-tui-app`

English | [中文](README.zh.md)

The dsh terminal-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides directly over [`dsh-base`](../base/README.md): it supplies the coding persona and tool mode, disables HMR, mounts Code Mode's worker as a core execution capability, and inserts this package's `tui-runner` plugin plus its `tui-startup` provider. It mounts no Host, HTTP server, Web runtime, or browser plugin.

After the Loader settles, the runner reads the shared [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md), creates one fresh persisted Agent through `ctx.agents`, and drives a full-screen terminal interface over the process TTY: a scrolling transcript folded from the session's `session/event` firehose, a prompt input line with emacs-style editing, in-memory history, and slash-command completion, a model/turn status bar, and in-line widgets that answer ask-user questions ([`dsh-user-questions`](../../interaction/user-questions/README.md)) and approval requests ([`dsh-user-approval`](../../interaction/user-approval/README.md)) for the TUI's own Agent. Slash commands run through the shared command runtime ([`dsh-commands`](../../interaction/commands/README.md)); the runner registers `/exit` and `/help` itself, so `/compact`, `/goal`, `/permission`, and every other composed command work without TUI-specific code. Tab completes the leading command name from the runtime's registry — a lone match fills the line directly, several matches open a popup that `↑`/`↓` navigates, Tab or Enter accepts, and Esc closes — and the same registry feeds `/help`. The optional initial prompt positional (`dsh tui "run the tests"`) is submitted once the interface is ready.

The terminal layer is deterministic and hand-rolled: a wcwidth-based display-width table ([`src/width.ts`](src/width.ts)), an escape-sequence keystroke parser ([`src/keys.ts`](src/keys.ts)), a pure frame composer and row-diff renderer ([`src/render.ts`](src/render.ts)), and a driver seam ([`src/terminal.ts`](src/terminal.ts)) whose production half manages raw mode, the alternate screen, and resize, while `VirtualTerminal` feeds the tests. Output is styled only when `NO_COLOR` is unset; `TERM=dumb` or non-TTY stdio fails loud with a pointer to the headless profile.

The runner exits through the launcher-provided `ctx.appExit` host hook ([`dsh-cmdline`](../../boot/cmdline/README.md)) on `/exit`, `Ctrl+D`, or `Ctrl+C` while idle, flushing the Session first; fiber disposal (a signal) restores the terminal. `Ctrl+C` while a turn runs cancels it; questions and approvals settle through the same in-line widgets.

## Model Experience

None, as the runner submits prompts as ordinary user messages and its own command handlers never reach the model; prompts and tools belong to the composed base rows.

#### KV Cache effect

None; the runner adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **One conversation per launch** — `--resume` is not implemented; a fresh session starts on every boot, and prompt history is in-memory only.
- **Single-line input** — the editor soft-wraps long prompts but pasted line breaks collapse to spaces; there is no multi-line editing mode.
- **Command-name completion only** — Tab completes the leading command token while the line is still a pure command prefix; command arguments get no candidates.
- **`ctx.appExit` is launcher-owned** — booting the tui profile outside the `dsh` launcher fails loud at activation until the host provides the exit request.
- **Width approximation** — East Asian Ambiguous code points measure one column, and emoji ZWJ sequences measure as the sum of their parts, so unusual glyphs may misalign until the renderer grows a grapheme-cluster pass.
