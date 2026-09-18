---
description: "dsh 终端界面 bundle：叠加在 dsh-base 之上的全屏交互式 TUI，供用户在终端中驱动单段 Agent 对话。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-tui-app`

[English](README.md) | 中文

## 概述

`dsh-tui-app` 增加 `dsh tui`：围绕单段 dsh Agent 对话的全屏终端界面，包含可滚动记录、emacs 风格提示词编辑、斜杠命令，以及就地的问题与审批控件。随附的 `tui` profile 把它组合在 `dsh-base` 之上，`dsh tui` 以 `dsh web` 启动浏览器表层的方式启动该 profile。它不打开端口，也不挂载 Host、HTTP 或浏览器插件；它需要交互式终端，因此管道与脚本应使用 `dsh --profile headless`。会话续接内置：`--resume <id>` 加载持久化会话，`--list` 打印最近会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`dsh tui` 启动随附的 `tui` profile——[`dsh-base`](../base/README.zh.md) 加上本 bundle 的 patch——并在终端中驱动单段 Agent 对话。它不挂载 Host、HTTP 服务器、Web 运行时或浏览器插件，且需要交互式 TTY：`TERM=dumb` 或非 TTY 标准流会立即报错并提示改用 headless profile。

Loader 就绪后，runner 读取共享的 [`ctx.agentDefaultModel`](../../core/agent-default-model/README.zh.md)，通过 `ctx.agents` 创建一个新的持久化 Agent，并在进程 TTY 上驱动全屏终端界面：由会话 `session/event` 事件流折叠而成的可滚动记录、带 emacs 风格编辑、单词导航、内存历史、kill ring 与斜杠命令补全的输入行、模型/回合状态栏，以及为 TUI 自己的 Agent 就地回答 ask-user 问题（[`dsh-user-questions`](../../interaction/user-questions/README.zh.md)）与审批请求（[`dsh-user-approval`](../../interaction/user-approval/README.zh.md)）的交互控件。斜杠命令走共享命令运行时（[`dsh-commands`](../../interaction/commands/README.zh.md)）；runner 自身注册 `/exit` 与 `/help`，因此 `/compact`、`/goal`、`/permission` 等所有组合中的命令无需 TUI 专用代码即可使用。Tab 从运行时注册表补全行首命令名——唯一匹配直接填充，多个匹配弹出候选列表，`↑`/`↓` 选择、Tab 或 Enter 接受、Esc 关闭——同一注册表也驱动 `/help`。可选的首条提示词（`dsh tui "run the tests"`）在界面就绪后自动提交。

终端层是确定性的手写实现：基于 wcwidth 的显示宽度表（[`src/width.ts`](src/width.ts)）、支持修饰箭头与 alt 字符解码的转义序列按键解析器（[`src/keys.ts`](src/keys.ts)）、无区域依赖的单词导航（[`src/word.ts`](src/word.ts)）、纯函数帧合成与行差异渲染器（[`src/render.ts`](src/render.ts)），以及驱动接缝（[`src/terminal.ts`](src/terminal.ts)）——其生产实现管理 raw 模式、备用屏幕与窗口尺寸变化，`VirtualTerminal` 则为测试服务。仅当未设置 `NO_COLOR` 时才输出样式。

会话可以续接而不是重新开始：`dsh tui --resume <id>` 经 `ctx.agents.resume` 加载持久化会话并把日志回放进记录，`dsh tui --resume`（不带 id）从 `ctx.sessionQuery` 打开最近会话选择器（`↑`/`↓` 选择、Enter 确认、Esc 取消转新会话），`dsh tui --list` 打印最近会话并退出。

编辑器按区间 kill（`Ctrl+W` 删前一单词、`Alt+D` 删后一单词、`Ctrl+U` 删到行首、`Ctrl+K` 删到行尾）并存入小型 kill ring，用 `Ctrl+Y`/`Alt+Y` 粘贴，用 `Alt+B`/`Alt+F` 或 `Ctrl+←`/`Ctrl+→` 按单词移动。视口支持整页翻页、半页（`Ctrl+↑`/`Ctrl+↓`）、单行（`Alt+↑`/`Alt+↓`）滚动，以及用户提示词之间的跳转（`Ctrl+Shift+↑`/`Ctrl+Shift+↓`）。

通过共享呈现词汇表声明 `card: 'diff'` 视图的工具（[`dsh-tools`](../../core/tools/README.zh.md)）在记录中渲染为着色的路径、删除与新增行；其他调用保持通用的"名称+参数"折叠。当组装包含 [`dsh-token-meter`](../../llm/token-meter/README.zh.md) 时，状态栏在每个回合后显示实测的上下文 token 数（`ready · ctx 4.3k`）。

runner 在 `/exit`、`Ctrl+D` 或空闲时按 `Ctrl+C` 时通过启动器提供的 `ctx.appExit` 宿主钩子（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)）退出，退出前先刷新 Session；fiber 销毁（如收到信号）会恢复终端。回合运行中按 `Ctrl+C` 会取消该回合；问题与审批都通过同一套就地控件完成。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.zh.md) 之上：提供编码 persona 与工具模式，保持与 Web 表层相同的临时进程级 PTC 模式开关（`DSH_TOOLS_MODE`），禁用共享 HMR 行，并插入本包的 `tui-startup` 提供者与 `tui-runner` 插件。runner 行注入 `tuiStartup` 并从惰性 config 读取解析后的调用，与 headless 表层读取 `headlessStartup` 的方式一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `tui-runner` 插件：Agent 创建与续接、输入循环、记录、控件、命令、退出 |
| [`src/startup.ts`](src/startup.ts) | `tui-startup` 提供者：首条提示词位置参数、`--resume`、`--list` 与 `--help` |
| [`src/terminal.ts`](src/terminal.ts) | 驱动接缝：raw 模式、备用屏幕、尺寸变化；测试用 `VirtualTerminal` |
| [`src/keys.ts`](src/keys.ts) | 转义序列按键解析器：修饰箭头、alt 字符、括号粘贴 |
| [`src/render.ts`](src/render.ts) | 纯函数帧合成与行差异渲染器 |
| [`src/transcript.ts`](src/transcript.ts) | 把会话事件折叠为带样式的记录行 |
| [`src/complete.ts`](src/complete.ts) | 从命令运行时取得斜杠命令补全候选 |
| [`src/history.ts`](src/history.ts) | 内存中的提示词历史 |
| [`src/width.ts`](src/width.ts) | 基于 wcwidth 的显示宽度表 |
| [`src/word.ts`](src/word.ts) | 无区域依赖的单词导航 |
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 上的 tui patch |
| — | 不发布运行时不变式伴随插件；TUI 是进程级呈现表层，其可观察契约（精确终端帧、就地回答、退出行为）由 PTY e2e 拥有，包内不存在可变关系。 |
| [`tests/tui.spec.ts`](tests/tui.spec.ts) | 在虚拟终端上覆盖提示、问题、审批、命令与退出 |
| [`apps/cli/tests/tui-pty.e2e.ts`](../../../apps/cli/tests/tui-pty.e2e.ts) | 在真实 PTY 下的单段对话，断言精确控制序列 |

### 不变式归属

不发布运行时不变式伴随插件，因为 TUI 是进程级呈现表层：其可观察契约（精确终端帧、就地回答、退出行为）由 PTY e2e 拥有，插件在组合树内不持有任何若损坏可被运行时检查更早发现的可变关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-base`](../base/README.zh.md)——本 bundle 所叠加的共享第一层。
- [`dsh-headless`](../headless/README.zh.md)——用于管道、脚本与 CI 的一次性表层。
- [`dsh-web-app`](../web-app/README.zh.md)——基于同一 base 的浏览器表层。
- [架构](../../../docs/architecture.zh.md)——bundle 如何叠放成 profile。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 runner 把提示词作为普通用户消息提交，它自己注册的命令处理器不会进入模型；提示词与工具归组合出的 base 行所有。

#### KV Cache 影响

无；runner 不改变请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **没有会话标题** — resume 选择器与 `--list` 只显示会话 id 与创建时间；dsh 的 session-title 投影尚未接入列表。
- **单行输入** — 编辑器会对长提示词软换行，但粘贴的换行会折叠为空格；没有多行编辑模式。
- **只补全命令名** — Tab 仅在行仍是纯命令前缀时补全行首命令 token；命令参数没有候选。
- **单词导航基于空白符** — `Alt+B/F` 与各 kill 操作把任意非单词、非空白字符段（含非拉丁文字）当作一个单位；尚未实现真正的文本分词器。
- **`ctx.appExit` 由启动器提供** — 在 `dsh` 启动器之外启动 tui profile 时，激活阶段会直接报错，直到宿主提供退出请求。
- **宽度近似** — 东亚 Ambiguous 码点按一列计算，emoji ZWJ 序列按各部分宽度相加，在渲染器支持字素簇之前，特殊字形可能对不齐。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`PROFILE_TEMPLATES.tui` 之所以能解析，是因为 `apps/cli` 把 `@deepseek-ai/dsh-tui-app` 声明为依赖；去掉这条依赖会让 `dsh tui` 在 profile 解析阶段失败。帧级行为由本包的单元测试固定，进程级契约由 `apps/cli/tests` 下的 PTY e2e 固定。

</details>
