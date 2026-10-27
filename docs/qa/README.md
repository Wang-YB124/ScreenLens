# QA 记录

这两份汇总对应 ScreenLens 1.1.0 的「相关」标签页与翻译/解释回归测试，均为 10 个场景、每轮检查关键词、站点、链接格式、翻译与渲染。

## 零额度回归（本地 Mock AI + 免费翻译）

- 汇总：[free-rounds-summary.json](free-rounds-summary.json)
- 结果：10/10 通过。
- 方法：9 轮使用本地 OpenAI 兼容 Mock 模拟 AI，中文技术说明轮使用 MyMemory 免费翻译；不调用付费接口。
- 第 6 轮故意让 Mock 返回非法关键词 JSON，验证自动回退本地提取并显示提示。
- 本机没有 Ollama/LM Studio，因此这不是真实模型质量测试。

## 真实 DeepSeek 验证

- 汇总：[real-deepseek-summary.json](real-deepseek-summary.json)
- 结果：10/10 通过。
- 方法：使用 DeepSeek `deepseek-chat` 的临时配置，真实翻译、解释与关键词；测试完成后清理临时配置，Key 未写入仓库。
- 发现真实模型会把 OCR 压平的 Python `def`/`return` 合并为一行；已在 `src/core/translate.js` 增加确定性版式修复，并通过 `test/code-layout-test.js` 单测和真实模型复测。
- 免费翻译轮仍使用 MyMemory；该 Key 不支持视觉，因此未测试真实多模态读图。

## 链接抽查

- 必应、百度、Stack Overflow、GitHub、Wolfram Alpha、PubMed、Bing 新闻可访问（Stack Overflow 返回 403 反爬响应，但仍可打开）。
- Wikipedia 与 Google Scholar 在测试网络直连超时（系统代理未启用）；URL 编码与站点格式正确，需在可访问网络使用。

## 截图

界面截图见 [docs/screenshots](../screenshots/)。完整逐轮截图位于本地 `test/shots/`（不纳入仓库）。

## 实时字幕交互验证（2026-10-27）

- 范围：字幕拖动、字幕内设置面板、字号、背景不透明度、原文/译文语言、语言切换重译、关闭淡出、文字区点击穿透、顶部控制条交互、置顶保持。
- 开发版真实鼠标测试（3 轮）：
  - 齿轮打开面板、A+ 两次（字号 20→24）、不透明度 92%→60%、目标语言切到「日本語」，均持久化到 `settings.realtime`；方向标签更新为 `EN → 日本語`，MyMemory 返回日文译文。
  - 拖动把手：窗口位移与鼠标位移一致（+90/+50）；修复了 `setPosition` 累积造成的宽度漂移（修复后宽度保持 980），拖动期间暂停自动增高。
  - 文字区点击不进入字幕窗口（点击计数不变），顶部控制条点击正常；控制条周期性置顶，避免被其他置顶窗口压住。
  - 点击 ×：先出现淡出动画（`.closing`），随后窗口销毁、`realtime.active=false`。
- 打包版冒烟：`ScreenLens.exe`（1.1.0）冷启动后重复打开设置、字号 24、拖动 +60/+30（宽度 980 不变）、× 关闭淡出并停止，全部通过。
- 说明：免费翻译 en→ja 偶发超过 15 秒返回，属于 MyMemory 网络延迟；语言切换会立即刷新方向标签并触发重译，最终返回日文译文。
- 截图：`docs/screenshots/realtime.png`（字幕设置面板）；逐轮截图在本地 `test/tmp/rt-final-*.png`、`rt-os-*.png`，不纳入仓库。
