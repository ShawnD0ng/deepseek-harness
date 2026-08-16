# `@deepseek-ai/dsh-tui-app`

[English](README.md) | 中文

dsh 终端界面 bundle。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.md) 之上：提供编码 persona 与工具模式、禁用 HMR、把 Code Mode 的 worker 挂载为核心执行能力，并插入本包的 `tui-runner` 插件及其 `tui-startup` 提供者。它不挂载 Host、HTTP 服务器、Web 运行时或浏览器插件。

Loader 就绪后，runner 读取共享的 [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md)，通过 `ctx.agents` 创建一个新的持久化 Agent，并在进程 TTY 上驱动全屏终端界面：由会话 `session/event` 事件流折叠而成的可滚动记录、带 emacs 风格编辑、单词导航、内存历史、kill ring 与斜杠命令补全的输入行、模型/回合状态栏，以及为 TUI 自己的 Agent 就地回答 ask-user 问题（[`dsh-user-questions`](../../interaction/user-questions/README.md)）与审批请求（[`dsh-user-approval`](../../interaction/user-approval/README.md)）的交互控件。斜杠命令走共享命令运行时（[`dsh-commands`](../../interaction/commands/README.md)）；runner 自身注册 `/exit` 与 `/help`，因此 `/compact`、`/goal`、`/permission` 等所有组合中的命令无需 TUI 专用代码即可使用。Tab 从运行时注册表补全行首命令名——唯一匹配直接填充，多个匹配弹出候选列表，`↑`/`↓` 选择、Tab 或 Enter 接受、Esc 关闭——同一注册表也驱动 `/help`。可选的首条提示词（`dsh tui "run the tests"`）在界面就绪后自动提交。

终端层是确定性的手写实现：基于 wcwidth 的显示宽度表（[`src/width.ts`](src/width.ts)）、支持修饰箭头与 alt 字符解码的转义序列按键解析器（[`src/keys.ts`](src/keys.ts)）、无区域依赖的单词导航（[`src/word.ts`](src/word.ts)）、纯函数帧合成与行差异渲染器（[`src/render.ts`](src/render.ts)），以及驱动接缝（[`src/terminal.ts`](src/terminal.ts)）——其生产实现管理 raw 模式、备用屏幕与窗口尺寸变化，`VirtualTerminal` 则为测试服务。仅当未设置 `NO_COLOR` 时才输出样式；`TERM=dumb` 或非 TTY 标准流会立即报错并提示改用 headless profile。

会话可以续接而不是重新开始：`dsh tui --resume <id>` 经 `ctx.agents.resume` 加载持久化会话并把日志回放进记录，`dsh tui --resume`（不带 id）从 `ctx.sessionQuery` 打开最近会话选择器（`↑`/`↓` 选择、Enter 确认、Esc 取消转新会话），`dsh tui --list` 打印最近会话并退出。

编辑器按区间 kill（`Ctrl+W` 删前一单词、`Alt+D` 删后一单词、`Ctrl+U` 删到行首、`Ctrl+K` 删到行尾）并存入小型 kill ring，用 `Ctrl+Y`/`Alt+Y` 粘贴，用 `Alt+B`/`Alt+F` 或 `Ctrl+←`/`Ctrl+→` 按单词移动。视口支持整页翻页、半页（`Ctrl+↑`/`Ctrl+↓`）、单行（`Alt+↑`/`Alt+↓`）滚动，以及用户提示词之间的跳转（`Ctrl+Shift+↑`/`Ctrl+Shift+↓`）。

通过共享呈现词汇表声明 `card: 'diff'` 视图的工具（[`dsh-tools`](../../core/tools/README.md)）在记录中渲染为着色的路径、删除与新增行；其他调用保持通用的"名称+参数"折叠。当组装包含 [`dsh-token-meter`](../../llm/token-meter/README.md) 时，状态栏在每个回合后显示实测的上下文 token 数（`ready · ctx 4.3k`）。

runner 在 `/exit`、`Ctrl+D` 或空闲时按 `Ctrl+C` 时通过启动器提供的 `ctx.appExit` 宿主钩子（[`dsh-cmdline`](../../boot/cmdline/README.md)）退出，退出前先刷新 Session；fiber 销毁（如收到信号）会恢复终端。回合运行中按 `Ctrl+C` 会取消该回合；问题与审批都通过同一套就地控件完成。

## Model Experience

无，因为 runner 把提示词作为普通用户消息提交，它自己注册的命令处理器不会进入模型；提示词与工具归组合出的 base 行所有。

#### KV Cache effect

无；runner 不改变请求前缀。

## Known Limitations and Deferred Work

- **没有会话标题** — resume 选择器与 `--list` 只显示会话 id 与创建时间；dsh 的 session-title 投影尚未接入列表。
- **单行输入** — 编辑器会对长提示词软换行，但粘贴的换行会折叠为空格；没有多行编辑模式。
- **只补全命令名** — Tab 仅在行仍是纯命令前缀时补全行首命令 token；命令参数没有候选。
- **单词导航基于空白符** — `Alt+B/F` 与各 kill 操作把任意非单词、非空白字符段（含非拉丁文字）当作一个单位；尚未实现真正的文本分词器。
- **`ctx.appExit` 由启动器提供** — 在 `dsh` 启动器之外启动 tui profile 时，激活阶段会直接报错，直到宿主提供退出请求。
- **宽度近似** — 东亚 Ambiguous 码点按一列计算，emoji ZWJ 序列按各部分宽度相加，在渲染器支持字素簇之前，特殊字形可能对不齐。
