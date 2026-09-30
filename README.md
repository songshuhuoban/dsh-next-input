# 下一条输入建议（dsh-next-input）

助手回复完成后，在空白输入框中显示一条可能的下一句回复。按 **Tab** 填入草稿，再由你编辑或发送。

插件直接沿用当前会话的模型和凭据，无需另填 API Key。

**支持版本：** DSH **0.2.0-rc.2**，对应插件 **0.2.0**。

[npm 包](https://www.npmjs.com/package/dsh-next-input) · [问题反馈](https://github.com/songshuhuoban/dsh-next-input/issues)

## 安装

### 图形界面（桌面版）

1. 点击左侧 **插件**，再点击右上角 **添加插件**。
2. 在 **包名或地址** 中输入：

   ```text
   dsh-next-input@0.2.0
   ```

3. 点击 **安装**。
4. 安装完成后点击 **立即启用**。

<details>
<summary>查看图形界面安装示意</summary>

![桌面安装步骤：左侧插件 → 添加插件 → 输入包名 → 安装](https://raw.githubusercontent.com/songshuhuoban/dsh-next-input/main/docs/images/install-gui.png)

</details>

如果镜像源暂时找不到这个版本，在 **安装源** 中切换到 npm 官方源后重试。

### 命令行（CLI Web 版）

使用 DSH **0.2.0-rc.2** 的 CLI，执行：

```sh
dsh plugin --profile web add dsh-next-input@0.2.0 --registry=https://registry.npmjs.org/
```

安装完成后，重新启动该 Web 实例并刷新页面。

CLI 的 `web` 环境和桌面版分别管理插件。使用桌面版时，请按上面的图形界面步骤安装。

## 使用

1. 正常与助手对话，等待本轮回复和任务全部完成。
2. 保持输入框为空，稍等片刻，建议会显示在输入框的占位文字中。
3. 按 **Tab** 将建议填入输入框，按需编辑后再发送。

不想采用建议时，直接输入自己的内容即可。本轮建议会消失；即使之后把内容删空，也要等下一轮助手完成后才会重新生成。

**Tab 只在输入框完全为空且有有效建议时补全。** 空格、换行、附件或引用都算已有输入；使用输入法选字时也不会接受建议。建议不会自动发送。

生成失败或等待超时后，输入框保持默认占位文字，你可以照常输入。

## 设置

打开左侧 **插件**，点击 **下一条输入建议**，在详情页调整设置并点击 **保存**。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| 启用建议 | 启用 | 是否自动生成下一句回复建议 |
| 失败重试次数 | 3 次 | 首次失败后，最多再尝试几次 |
| 每次请求超时（毫秒） | 15000（15 秒） | 每次整理上下文并生成建议的最长等待时间 |
| 建议最大字数 | 240 | 建议内容的长度上限 |

通常保持默认设置即可。模型响应较慢或对话很长时，可以适当增加超时。要恢复某一项设置，点击该项的 **恢复默认**，再点击 **保存**。

建议生成和长会话摘要会调用当前会话的模型，产生该模型的正常调用费用。

## 更多说明

### 升级与兼容

桌面版暂不自动更新插件。升级时，先在插件详情页卸载旧版，再通过 **添加插件** 安装新版本并启用。

如果旧版 `0.1.0` 安装失败，可以返回编辑，将包名改为 `dsh-next-input@0.2.0` 后重新安装。插件 `0.1.0` 仅支持 DSH `0.1.7-rc.2`；插件 `0.2.0` 支持 DSH `0.2.0-rc.2`。

也可以从 [GitHub Release](https://github.com/songshuhuoban/dsh-next-input/releases/tag/v0.2.0) 下载预构建的 `dsh-next-input.tgz`，在桌面安装窗口中填写下载文件的完整路径后安装。

### 建议如何生成

插件只在助手本轮全部结束、没有待处理输入时请求建议。新会话、新回合、发送消息或开始执行任务时，会立即清除上一轮建议。

每个请求带有会话、回合、递增请求 ID 和时间戳。多个结果同时返回时，仅接受当前轮次中最新请求的结果。手动输入、切换会话、修改配置或卸载插件会取消旧请求，迟到的结果会被丢弃。

默认首次失败后再重试 3 次，共最多 4 次建议生成尝试，每次独立计时。最终失败、取消、空结果和过期结果均静默丢弃，不改写草稿。没有有效建议时，Tab 保留原本行为；Shift+Tab、Ctrl+Tab 等组合键也保留原本行为。

### 上下文整理

短会话直接使用当前可见对话。长会话采用“滚动摘要 + 近期原文”：优先复用 dsh 已有的压缩摘要，再按需整理旧历史，保留用户目标、偏好、约束、决定和未解决的问题。摘要不会写入主会话，也不会改变原有对话记录。

<details>
<summary>展开上下文策略细节</summary>

- 从 `session.deriveMessages()` 读取当前有效对话，尊重已有压缩和替换，不从原始日志重新引入被压缩掉的消息。
- 优先复用 `compact-checkpoint`。不超过 16 条可见消息、总计 12,000 个 Unicode 字符的短会话直接保留原文。
- 长会话保留最近最多 8 条消息、10,000 个字符，将旧历史按顺序整理为最多 2,000 个字符的摘要。每次摘要调用最多处理 24,000 个字符，超出部分继续分块合并。
- 超长单条消息的旧部分进入摘要，近期尾部保留原文，避免直接截掉旧约束。
- 按会话与历史前缀缓存摘要，新消息加入时尽量只处理增量。历史编辑、检查点改变、模型切换或截分位置变化时重新核对缓存；成功的中间摘要可供重试复用。

以上是文本字符预算，不是 token 计数。摘要与建议沿用同一模型，受相同取消、超时和静默失败机制约束。

辅助调用会查询模型能力。只有模型明确声明支持 `off` 或 `none` 时才关闭推理，其余模型保留自身默认值；能力查询也计入请求超时。

</details>

### 开发与验证

<details>
<summary>展开源码构建与实现说明</summary>

开发环境需要 Node.js 22 或更新版本和 pnpm。目标 SDK 为 DSH `0.2.0-rc.2` / Cordis `4.0.4`。

```sh
git clone https://github.com/songshuhuoban/dsh-next-input.git
cd dsh-next-input
pnpm install
pnpm check
npm pack
```

构建产物为 `dsh-next-input-0.2.0.tgz`，可通过桌面插件页面安装。CLI Web 环境也可以在构建后执行 `dsh plugin --profile web add .` 安装本地目录。

Host 使用 `ctx.agents` 读取已完成回合，以 `ctx.llm.stream()` 发起独立辅助请求，沿用当前会话最近一个已完成请求的 provider/model。不附带原始工具输出、推理正文或主对话系统提示，不向主会话追加消息或启动 Agent。

通信复用 dsh Connection 的认证、取消与 RPC 信封，Host 注册精确的 `/api/next-input/suggest` Fetch 路由。

客户端挂载在 `conversation.input.overlay` 扩展槽，状态来自原生 Session/Input hooks，填入建议使用 `inputActions.captureInsertion()` / `insertText()` 的草稿版本检查。显示和 Tab 监听由所属 composer card 内的 DOM 适配器处理，依赖以下 DSH 0.2 标记：

```text
[data-composer-card]
[data-composer-input]
[data-composer-placeholder]
[data-composer-composing]
```

找不到标记时保持静默。卸载时恢复原占位文字并移除监听器，升级 dsh 时需要重新核对这些标记与公开类型。

`dsh.bundle.patch` 提供 `next-input` 插件条目，`./client` 与 `dsh.client` 元数据提供浏览器入口。客户端产物采用 dsh 的惰性 CommonJS factory 格式，共享平台提供的 React/UI 模块。

`pnpm check` 执行类型检查、并发与取消、重试与超时、上下文摘要与缓存、Host/LLM 协议、Cordis 生命周期、React StrictMode/会话切换、输入框 DOM、官方安装器兼容性，以及构建与发布文件检查。测试使用模拟模型和独立上下文，不更改正在运行的 dsh 环境。

</details>
