---
description: "The dsh terminal-surface bundle: a full-screen interactive TUI over dsh-base, for users who want to drive one agent conversation from the terminal."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-tui-app`

English | [中文](README.zh.md)

## Summary

`dsh-tui-app` adds `dsh tui`: a full-screen terminal interface over one dsh agent conversation, with a scrolling transcript, emacs-style prompt editing, slash commands, and in-line question and approval widgets. The shipped `tui` profile composes it over `dsh-base`, and `dsh tui` boots that profile the way `dsh web` boots the browser surface. It opens no port and mounts no Host, HTTP, or browser plugin, and it needs an interactive terminal, so pipes and scripts belong on `dsh --profile headless`. Session resume is built in: `--resume <id>` loads a persisted session, and `--list` prints recent ones.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`dsh tui` boots the shipped `tui` profile — [`dsh-base`](../base/README.md) plus this bundle's patch — and drives one agent conversation in the terminal. It mounts no Host, HTTP server, Web runtime, or browser plugin, and it needs an interactive TTY: `TERM=dumb` or non-TTY stdio fails loud with a pointer to the headless profile.

After the Loader settles, the runner reads the shared [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md), creates one fresh persisted Agent through `ctx.agents`, and drives a full-screen terminal interface over the process TTY: a scrolling transcript folded from the session's `session/event` firehose, a prompt input line with emacs-style editing, word navigation, in-memory history, a kill ring, and slash-command completion, a model/turn status bar, and in-line widgets that answer ask-user questions ([`dsh-user-questions`](../../interaction/user-questions/README.md)) and approval requests ([`dsh-user-approval`](../../interaction/user-approval/README.md)) for the TUI's own Agent. Slash commands run through the shared command runtime ([`dsh-commands`](../../interaction/commands/README.md)); the runner registers `/exit` and `/help` itself, so `/compact`, `/goal`, `/permission`, and every other composed command work without TUI-specific code. Tab completes the leading command name from the runtime's registry — a lone match fills the line directly, several matches open a popup that `↑`/`↓` navigates, Tab or Enter accepts, and Esc closes — and the same registry feeds `/help`. The optional initial prompt positional (`dsh tui "run the tests"`) is submitted once the interface is ready.

The terminal layer is deterministic and hand-rolled: a wcwidth-based display-width table ([`src/width.ts`](src/width.ts)), an escape-sequence keystroke parser with modified-arrow and alt-character decoding ([`src/keys.ts`](src/keys.ts)), locale-free word navigation ([`src/word.ts`](src/word.ts)), a pure frame composer and row-diff renderer ([`src/render.ts`](src/render.ts)), and a driver seam ([`src/terminal.ts`](src/terminal.ts)) whose production half manages raw mode, the alternate screen, and resize, while `VirtualTerminal` feeds the tests. Output is styled only when `NO_COLOR` is unset.

A session can be resumed instead of started fresh: `dsh tui --resume <id>` loads the persisted session through `ctx.agents.resume` and replays its log into the transcript, `dsh tui --resume` (no id) opens a recent-session picker from `ctx.sessionQuery` (`↑`/`↓` select, Enter confirm, Esc cancel to a fresh session), and `dsh tui --list` prints recent sessions and exits.

The editor kills by span (`Ctrl+W` backward word, `Alt+D` forward word, `Ctrl+U` to the line start, `Ctrl+K` to the line end) into a small kill ring and yanks with `Ctrl+Y`/`Alt+Y`, and it moves by word with `Alt+B`/`Alt+F` or `Ctrl+←`/`Ctrl+→`. The viewport scrolls by page, by half page (`Ctrl+↑`/`Ctrl+↓`), by line (`Alt+↑`/`Alt+↓`), or jumps between user prompts (`Ctrl+Shift+↑`/`Ctrl+Shift+↓`).

Tools that declare a `card: 'diff'` view through the shared presentation vocabulary ([`dsh-tools`](../../core/tools/README.md)) render in the transcript as colored path, removed, and added lines; other calls keep the generic name-and-arguments fold. When the composition carries [`dsh-token-meter`](../../llm/token-meter/README.md), the status bar shows the measured context tokens after each turn (`ready · ctx 4.3k`).

The runner exits through the launcher-provided `ctx.appExit` host hook ([`dsh-cmdline`](../../boot/cmdline/README.md)) on `/exit`, `Ctrl+D`, or `Ctrl+C` while idle, flushing the Session first; fiber disposal (a signal) restores the terminal. `Ctrl+C` while a turn runs cancels it; questions and approvals settle through the same in-line widgets.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) rides directly over [`dsh-base`](../base/README.md): it supplies the coding persona and tool mode, keeps the same temporary process-wide PTC mode opt-in (`DSH_TOOLS_MODE`) as the Web surface, disables the shared HMR row, and inserts this package's `tui-startup` provider plus the `tui-runner` plugin. The runner row injects `tuiStartup` and reads the parsed invocation from lazy config, mirroring how the headless surface reads `headlessStartup`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `tui-runner` plugin: Agent creation and resume, input loop, transcript, widgets, commands, exit |
| [`src/startup.ts`](src/startup.ts) | The `tui-startup` provider: initial prompt positional, `--resume`, `--list`, and `--help` |
| [`src/terminal.ts`](src/terminal.ts) | The driver seam: raw mode, alternate screen, resize; `VirtualTerminal` for tests |
| [`src/keys.ts`](src/keys.ts) | Escape-sequence keystroke parser: modified arrows, alt characters, bracketed paste |
| [`src/render.ts`](src/render.ts) | Pure frame composer and row-diff renderer |
| [`src/transcript.ts`](src/transcript.ts) | Session-event fold into styled transcript lines |
| [`src/complete.ts`](src/complete.ts) | Slash-command completion candidates from the command runtime |
| [`src/history.ts`](src/history.ts) | In-memory prompt history |
| [`src/width.ts`](src/width.ts) | wcwidth-based display-width table |
| [`src/word.ts`](src/word.ts) | Locale-free word navigation |
| [`cordis.patch.yml`](cordis.patch.yml) | The tui patch over `dsh-base` |
| — | No runtime invariant companion is published; the TUI is a process-level presentation surface whose observable contract (exact terminal frames, in-line answers, exit behavior) is owned by the PTY e2e, and it holds no mutable relation inside the tree. |
| [`tests/tui.spec.ts`](tests/tui.spec.ts) | Prompting, questions, approvals, commands, and exit against a virtual terminal |
| [`apps/cli/tests/tui-pty.e2e.ts`](../../../apps/cli/tests/tui-pty.e2e.ts) | One real conversation under a PTY, asserting the exact control sequences |

### Invariant ownership

No runtime invariant companion is published because the TUI is a process-level presentation surface: its observable contract (exact terminal frames, in-line answers, exit behavior) is owned by the PTY e2e, and the plugin holds no mutable relation inside the tree whose corruption a runtime check would catch earlier.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-base`](../base/README.md) — the shared first layer this bundle patches.
- [`dsh-headless`](../headless/README.md) — the one-shot surface for pipes, scripts, and CI.
- [`dsh-web-app`](../web-app/README.md) — the browser surface over the same base.
- [Architecture](../../../docs/architecture.md) — how bundles stack into a profile.

-----

<a id="model-experience"></a>
## Model Experience

None, as the runner submits prompts as ordinary user messages and its own command handlers never reach the model; prompts and tools belong to the composed base rows.

#### KV Cache effect

None; the runner adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **No session titles** — the resume picker and `--list` show a session id and creation time; dsh's session-title projection is not wired into the listing.
- **Single-line input** — the editor soft-wraps long prompts but pasted line breaks collapse to spaces; there is no multi-line editing mode.
- **Command-name completion only** — Tab completes the leading command token while the line is still a pure command prefix; command arguments get no candidates.
- **Whitespace-based word navigation** — `Alt+B/F` and the word kills treat any run of non-word, non-space characters (including non-Latin scripts) as one unit; there is no real text segmenter yet.
- **`ctx.appExit` is launcher-owned** — booting the tui profile outside the `dsh` launcher fails loud at activation until the host provides the exit request.
- **Width approximation** — East Asian Ambiguous code points measure one column, and emoji ZWJ sequences measure as the sum of their parts, so unusual glyphs may misalign until the renderer grows a grapheme-cluster pass.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`PROFILE_TEMPLATES.tui` resolves only because `apps/cli` declares `@deepseek-ai/dsh-tui-app` as a dependency; dropping that edge makes `dsh tui` fail at profile resolution. Frame-level behavior is pinned by this package's unit tests, and the process-level contract by the PTY e2e under `apps/cli/tests`.

</details>
