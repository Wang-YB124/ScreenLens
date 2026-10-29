# ScreenLens Code

在 VS Code、Cursor 或 Qoder 中选中代码，直接解释或生成修正；修正先打开 diff，确认后才写回编辑器。也可以配合 ScreenLens 的「代码字幕」实时暂存当前文件，达到阈值后自动生成解释与修正建议。

## 代码字幕（实时桥接）

1. 在 ScreenLens 设置 → 实时字幕 → 字幕来源中选择「VS Code 编辑器」，按需设置解释阈值与自动审阅开关。
2. 在编辑器中打开要写作的文件；扩展会通过状态栏显示连接状态，并把当前文件暂存到 ScreenLens 的字幕条。
3. 达到阈值后，ScreenLens 用其配置的 AI 模型生成解释、风险与修正建议；也可以在字幕条点「审阅」手动触发。
4. 停止字幕后，ScreenLens 删除桥接文件，内存中的代码同时清除。

桥接只监听 `127.0.0.1` 随机端口，使用每次启动随机生成的 Bearer 令牌。默认桥接文件为 `%APPDATA%\ScreenLens\editor-bridge.json`；如果 ScreenLens 使用了自定义数据目录，可在设置 `screenlens.bridgeFile` 中指定。

## 快捷键

- `Ctrl+Alt+E`：解释选中代码
- `Ctrl+Alt+F`：生成修正并打开 diff 预览
- 也可以右键选中代码，在命令面板运行 `ScreenLens: ...`

## 配置 API

首次使用：

1. 打开命令面板（`Ctrl+Shift+P`）
2. 运行 `ScreenLens: 设置 API Key`
3. 粘贴兼容 OpenAI 接口的 Key；Key 只保存到 VS Code 的 SecretStorage

默认使用 DeepSeek：

- 接口：`https://api.deepseek.com/v1`
- 模型：`deepseek-chat`

也可以用 Ollama 等本地兼容服务，例如：

- 接口：`http://127.0.0.1:11434/v1`
- 模型：`qwen2.5:7b`
- API Key 可留空

说明：选中代码的解释/修正使用扩展自己的 API Key；代码字幕的 AI 审阅沿用 ScreenLens 主程序配置的模型。

## 行为

- 解释/修正只读取当前选区及其前后少量上下文，不会上传整个工作区。
- 代码字幕只发送当前活动文件（最多约 6 万字符）到本机 ScreenLens；只有触发 AI 审阅时，才会由主程序发送给配置的模型。
- 修正结果先在 diff 中展示；点击“应用修正”后才写入文件；若期间文档发生变化会拒绝应用。
- 解释会写入扩展的全局存储目录并用 Markdown 预览打开，不写入项目文件。

## 配置项

- `screenlens.apiBaseUrl`
- `screenlens.model`
- `screenlens.explanationLanguage`
- `screenlens.temperature`
- `screenlens.includeDiagnostics`
- `screenlens.maxInputChars`
- `screenlens.bridgeFile`：代码字幕桥接文件路径；留空使用 `%APPDATA%\ScreenLens\editor-bridge.json`

## 安装

安装 VSIX：命令面板 → Extensions: Install from VSIX，选择 `ScreenLens-Code-0.2.1.vsix`（ScreenLens 发布包根目录也会附带）。

## 安全

代码会发送到你配置的模型服务。不要把真实 Key 写入 README、项目文件或提交记录；扩展不会自动修改代码，所有写回都需要 diff 确认。
