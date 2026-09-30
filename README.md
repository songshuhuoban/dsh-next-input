# dsh-next-input

为 DeepSeek Harness 的下一条用户输入生成建议：assistant 的回合全部结束、没有待处理输入时，在空输入框的 placeholder 中显示一条可能的回复。按 **Tab** 将建议填入草稿，之后仍由用户编辑或发送。

本插件针对 **dsh 0.1.7-rc.2 / Cordis 4.0.4** 开发，包含 Host 和 Web/桌面客户端两半。该版本的配置、输入框接口与旧版有差异，请使用匹配的版本。

当前发布版本为 `0.1.0`，仅支持上述 Harness 版本；`0.2.x` 尚未适配。[源码与问题反馈](https://github.com/songshuhuoban/dsh-next-input) · [npm 包](https://www.npmjs.com/package/dsh-next-input)。

## 使用行为

- 新会话、新回合、发送输入、开始执行时，立即清除上一轮建议，恢复 dsh 原有 placeholder。
- 只在输入框完全为空、没有附件或引用、未处于中文输入法组合阶段时接受 Tab。空格和换行也算已输入内容。
- 手动输入后，取消请求并使本轮建议失效；即使再删空，也保留默认 placeholder，下一轮才重新生成。
- Shift+Tab、Ctrl+Tab、Alt+Tab、Meta+Tab 保留原本行为。没有有效建议时，Tab 保留原本行为。
- 每个请求携带会话 ID、完成回合的事件序号、递增请求 ID 和时间戳。按请求 ID 判断新旧，时间戳相同或系统时间回拨也不会让旧响应覆盖新响应。
- 默认首次失败后**再重试 3 次，共最多 4 次建议生成尝试**；每次有独立超时，可能包含多次摘要 LLM 调用。最终失败、取消、空结果和过期响应均静默丢弃，不显示错误，不写入草稿。
- 切换会话、重新执行、修改配置和卸载插件会取消旧请求；即使模型服务忽略取消，返回结果也不能通过当前轮次检查。

## 设置

在 dsh 的 **设置 → 插件 → dsh-next-input → 配置** 中管理。沿用 dsh 的配置继承、字段重置、保存和版本冲突处理。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 启用建议 |
| `maxRetries` | `3` | 首次失败后的重试次数 |
| `timeoutMs` | `15000` | 每次完整整理上下文并生成建议的超时，毫秒 |
| `maxSuggestionChars` | `240` | 建议的最大字符数 |

模型直接沿用当前会话最近一个已完成请求的 provider/model，凭据由 dsh 的 LLM adapter 解析。插件不需要另配 API Key、端点或模型列表。生成建议会产生该模型的正常调用费用。

辅助摘要和建议会查询 dsh 的模型能力。只有模型明确声明支持 `off` 或 `none` 时才关闭推理，以减少延迟；其余模型保留自身的推理默认值。模型能力查询也计入本次超时，并支持取消。

## 上下文整理

采用常见的“滚动摘要 + 近期原文”策略：

1. 从 `session.deriveMessages()` 读取 dsh 当前有效的对话表面，尊重已有压缩和替换，不从原始日志重新引入已被压缩掉的消息。
2. 优先复用 dsh 的 `compact-checkpoint` 摘要。短会话直接保留可见对话，避免增加一次摘要调用。
3. 较长会话保留近期原文，将旧历史按顺序分块整理为摘要。摘要重点保存用户目标、偏好、限制、已作出的决定、事实和未解决的问题。
4. 按会话和历史前缀缓存摘要。前缀和分块边界保持一致时，新消息加入只处理进入旧历史范围的增量；历史被编辑或替换、压缩检查点改变、模型切换或超长消息的截分位置变化时重新核对缓存。成功完成的中间摘要可以被后续重试复用。
5. 最终建议请求同时携带摘要与近期原文。所有摘要都只是辅助内存，不写入主会话，不触发 dsh 主会话压缩。

短会话在不超过 16 条可见消息、总计 12,000 个 Unicode 字符时保留原文。长会话保留最近最多 8 条消息、10,000 个字符，并将旧历史压缩到最多 2,000 个字符；每次摘要调用最多处理 24,000 个字符，超出部分继续按顺序合并。超长单条消息的旧部分进入摘要，近期尾部保留原文，不直接截掉旧约束。

这些是文本字符预算，不是模型 token 计数。摘要调用沿用同一模型，受同一取消、超时与静默失败机制约束；首次处理很长的历史时，可在设置中增加超时。

## 构建与安装

通过 npm 包安装到匹配版本的 Web profile：

```powershell
dsh plugin --profile web add dsh-next-input@0.1.0 --registry=https://registry.npmjs.org/
```

Desktop 使用自身的插件页面安装 `dsh-next-input@0.1.0`，或安装下方构建步骤生成的 `dsh-next-input-0.1.0.tgz`。CLI 的 `web` profile 与 Desktop 的插件环境分别管理；桌面环境也须匹配 dsh `0.1.7-rc.2`。

从源码构建：

```powershell
git clone https://github.com/songshuhuoban/dsh-next-input.git
cd dsh-next-input
pnpm install
pnpm check
npm pack
```

Web profile 可安装构建后的本地目录：

```powershell
dsh plugin --profile web add .
```

包中的 `dsh.bundle.patch` 插入稳定的 `next-input` 插件条目；`./client` 和 `dsh.client` 元数据负责发现浏览器入口。安装后按目标 profile 的机制重新加载插件或重启，以刷新 manifest 和客户端图。

## 实现与边界

Host 通过 `ctx.agents` 和会话公开日志读取已完成回合，以 `ctx.llm.stream()` 发起独立辅助请求。提供用户/assistant 可见文本及已存在的压缩摘要，限定消息数和字符预算；不附带原始工具输出、推理正文或主对话系统提示，也不向主会话追加消息或启动 Agent。

通信使用 dsh 的 Connection carrier：Host 注册精确的 `/api/next-input/suggest` Fetch 路由，复用客户端现有 RPC 请求/响应信封。鉴权、桌面传输、取消及请求关联仍由 Connection 负责。

客户端挂载在 `conversation.input.overlay` 扩展槽，状态来自现有 Session/Input hooks，建议插入走 `inputActions.captureInsertion()` / `insertText()` 的草稿版本检查。此版本没有公开的 placeholder/Tab 装饰接口，因此只有显示和按键使用限定在所属 composer card 内的 DOM 适配器，依赖以下 dsh 0.1.7 标记：

```text
[data-composer-card]
[data-composer-input]
[data-composer-placeholder]
[data-composer-composing]
```

找不到这些标记时功能保持静默，原有输入流程继续工作。卸载时恢复原 placeholder 并移除监听器。升级 dsh 时，应重新核对这些标记和公开类型。

## 验证

`pnpm check` 执行严格类型检查、并发/超时/取消测试、摘要与缓存测试、Host/LLM 协议测试、原生 Cordis 注册与卸载测试、React StrictMode/会话切换测试、输入框 DOM 适配测试、构建及发布文件检查。客户端产物以 dsh 的惰性 CommonJS factory 格式构建，并验证只使用平台提供的 React/UI 模块。

测试使用模拟模型和独立上下文，不更改正在运行的 dsh 环境。真实模型服务的延迟和模型回复质量需要在安装后验证。
