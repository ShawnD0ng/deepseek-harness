# Agent Note: dsh tui 终端界面

Status: implemented

[English](2026-08-14-terminal-tui-surface.md) | 中文

## Problem

dsh 有浏览器界面和一次性 headless 运行器，但没有交互式终端体验：想在终端里进行 Claude Code 式对话的用户，要么打开浏览器应用，要么反复编写 headless 调用的脚本。harness 已经具备终端界面所需的全部交互能力（会话事件流、ask-user 提供者接缝、审批 waterfall、斜杠命令运行时），因此缺口是表现层界面，而不是新的核心机制。

## Decision

`@deepseek-ai/dsh-tui-app` 是叠加在 `dsh-base` 之上的新 profile bundle，结构与 `dsh-headless` 相同：`cordis.patch.yml` 提供 persona、禁用共享 HMR 行、挂载 Code Mode 的 worker，并插入 `tui-startup` 提供者与 `tui-runner` 插件。启动器新增 `tui` profile 模板（`dsh-base` + `dsh-tui-app`）以及 `dsh web` 旁边的 `dsh tui` 别名。

runner 通过 `ctx.agents` 创建一个持久化 Agent，把它的 `session/event` 事件流折叠成有界记录，并在进程 TTY 上驱动全屏界面。终端层是手写的确定性实现：基于 wcwidth 的显示宽度表、带括号粘贴支持的转义序列按键解析器、纯函数帧合成加行差异渲染器，以及一个驱动接缝——其生产实现负责 raw 模式、备用屏幕、窗口尺寸变化与恢复（包括暂停 stdin 以便退出后事件循环可以排空）。设置 `NO_COLOR` 即禁用样式；`TERM=dumb` 或非 TTY 标准流会直接报错并指向 headless profile。

交互全部复用 harness 接缝：runner 注册活动的 `userQuestions` 提供者（就地菜单、多选切换、自由文本回答，均可中止），只为自己拥有的 Agent 回答 `approval/request`（其余请求沿 waterfall 向下委托），并通过 `ctx.commands` 注册 `/exit` 与 `/help`，因此 `/compact`、`/goal` 等组合中的命令无需 TUI 专用代码即可使用。斜杠命令、ask-user 问题与审批共享一个交互队列，问题不会与待处理的审批争抢键盘。可选的首条提示词（`dsh tui "run the tests"`）在界面就绪后提交；在 Agent 创建前输入的提示词会排队等待重放。

## Alternatives considered

**用 Ink（或 blessed）做渲染框架** — 拒绝。Ink 省掉了布局与输入处理代码，但为一个输出必须逐字节确定、以适配仓库快照式门禁的界面引入了 React 运行时、异步渲染循环与 testing-library 间接层；手写渲染器是纯同步的，单元测试可以比较精确帧，PTY e2e 可以断言精确的控制序列。

**把 ACP 客户端挂到一个单独运行的服务器上** — 拒绝。自然的调用方式是一条命令启动全部（`dsh tui`），与 headless、web 界面一致；额外的常驻服务器进程只增加编排负担，省不掉本 bundle 的任何代码。

**复用 `dsh-terminal` 的会话作为 UI 面板** — 拒绝。该包为 Agent 自己的工具模拟终端；TUI 需要的是小巧可控的终端抽象，而不是终端模拟协议，驱动接缝已经把真实 TTY 藏在接口之后。

## Consequences

终端界面只依赖现有交互接缝，因此不含 `dsh-user-questions`、`dsh-user-approval` 或 `dsh-commands` 的自定义组装仍然可以启动，并退化为普通聊天循环。渲染器的 wcwidth 近似（东亚 Ambiguous 按一列、emoji ZWJ 序列按各部分相加）会让特殊字形对不齐；包 README 记录了这一点以及其他延期工作（会话恢复、多行输入、持久化历史）。

## Verification

单元套件在 `VirtualTerminal` 上以 100% 每文件覆盖率覆盖宽度计算、按键解码、帧合成与差异、历史、记录投影以及完整交互矩阵（提示词、命令、问题、审批、取消、滚动钉住、退出路径）。`apps/cli/tests/tui-pty.e2e.ts` 在 PTY 中对 mock LLM 服务器启动真实的 `dsh tui` profile 树：输入提示词、观察流式回复与 spinner、发送 `/exit`，并断言干净退出且备用屏幕已恢复。
