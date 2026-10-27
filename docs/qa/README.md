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
