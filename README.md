# resume-stream

自动续传被掐断的 LLM 流式响应（"Stream ended without finish_reason"），**对所有
provider 生效**（不仅限于 opencode / Zen 网关），并在界面上给出明确提示与命中计数。

## 解决的问题

部分网关（如 opencode 的 Zen 网关 `https://opencode.ai/zen/go/v1`）会把完整内容
流式吐出，但**从不发送 `finish_reason` / `[DONE]`**，SSE 在最后一条
`{"choices":[],"cost":"0"}` 之后直接关闭，于是底层 `pi-ai` 抛出：

```
Stream ended without finish_reason
```

这个插件在宿主级 `llm/stream` 瀑布流里拦截该错误结束块，把它改写成一次**正常的
停止**（已流出的文本 / usage 原样保留），从而：

- 本轮不会因为缺 `finish_reason` 而报错中断；
- 已经生成的内容全部保留，模型相当于"从断点干净收尾"，而不是从零重来；
- **任何 provider** 触发的该错误都会被容忍（不再像上游 `llm-fallback` /
  `dsh-opencode-zen-compat` 那样只对 opencode 系生效）。

## UI（dsh 一切皆插件）

插件带一个**客户端 half**（`lib/client.js`，通过 `dsh.client.platform: web`
声明），提供两处界面反馈：

1. **`shell.overlay` 瞬时 toast**：每次发生断流续传时弹出一张 gitbash 风格卡片，
   "⚠️ 流式断流已自动续写（累计 ×N）"，数秒后自动消失。
2. **`conversation.chat.turnTail` 消息列表内联提示**：在每个完成的对话轮次之后显示
   一张卡片，带**累计命中计数 ×N** 和"最近一次 provider / 时间"，常驻于消息列表内。

计数通过宿主侧的 `harness.handle('resumeStreamGetState')` 暴露，客户端用
`host.call` 轮询读取；计数**尽力持久化**到 `.dsh/resume-stream-count.json`
（读取/写入失败不影响续传功能）。

## 安装（DSH profile bundle）

```bash
# 从 GitHub Release 安装（发布后会给出具体 tgz 链接）
dsh plugin --profile web add https://github.com/XJungit/resume-stream/releases/download/v1.0.0/resume-stream-1.0.0.tgz
```

> 安装 web 插件需要重启 DSH（会结束当前会话）。

## 验证

1. 用会触发该错误的模型（如经 9Router 路由到 opencode Zen 的 `oc/max`）发一条长消息；
2. 观察界面：应弹出 toast，且消息列表里出现"⚠️ 流式断流已自动续写 ×N"卡片；
3. 宿主日志应出现 `[resume-stream] 流式断流已自动续写（provider: …, 累计 ×N）`。

## 与上游的区别

- 上游 `llt22/dsh-opencode-zen-compat`：仅对 opencode 系 provider 作用域生效，
  且只做容错、无 UI。
- 本插件：去掉 opencode 作用域限制（**全 provider 生效**），并补上 gitbash 风格的
  toast + 消息列表内联计数提示。
