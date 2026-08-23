# @omdp/dsh-resume-stream

自动续传被掐断的 LLM 流式响应（TRANSPORT 类断流：`finish_reason` 缺失、连接提前关闭、
ECONNRESET 等），**对所有 provider 生效**，并只在真正发生了续流的轮次上显示内联徽章。

## 解决的问题

部分网关会把完整内容流式吐出，却从不发送 `finish_reason` / `[DONE]` 就关闭 SSE；也有
传输层中途断连的情况。底层 pi-ai 抛 `"Stream ended without finish_reason"`，而
dsh-llm-pi-ai 适配器会把它翻译成 in-band 的
`finish{kind:'error', failure:{code:'TRANSPORT'}}` 块再喂给宿主级 `llm/stream` 瀑布——
**在这一层拿到的是块，不是异常**（不要去 try/catch 一个并不存在的 throw）。

本插件的钩子只把该 TRANSPORT 错误结束块改写为 `{ ...chunk, reason:{kind:'stop'} }`：
已流出的文本与 usage 原样保留，模型相当于"从断点干净收尾"，而不是整轮报错、从零重来。
其它错误类别（AUTH / QUOTA / RATE_LIMIT / SERVER / CONTEXT_WINDOW_EXCEEDED /
PI_AI_ERROR 等）以及抛异常式失败（如 idle timeout）一律原样放行，交给上层重试机制。

## 自动接续（v1.0.12+）

改写成 stop 后 agent 轮次会干净结束——内容保住了，但进行中的任务会停在那里等人推。
对**真中断**（`Connection error.`、ECONNRESET、premature close 等），插件会通过
`agents.get(sessionId)` 取 live Agent，构造一条 plugin 来源的合成 user 消息并
`agent.followup(...)` 排队（与官方 goal-round-driver 同一机制），驱动器随即自行开启
下一轮继续工作，无需手动发"继续"。

两类断流区别对待：

- **真中断** → 改写 stop + 自动排队接续；
- **Zen 式干净 EOF**（`Stream ended without finish_reason`，正文其实已完整送达，
  只缺结束标记）→ 只改写 stop，不接续——此时让模型"继续"只会产出填充性废话。

防失控护栏：同一会话连续自动接续上限 **3 次**（任何一次正常收尾都会清零计数）；
3 秒去重窗防止并发双流重复排队。

## 机制（v1.0.10+）

- **Host 半**（`lib/index.js`）：`ctx.on('llm/stream')` 用 async generator 包住内部流做
  块改写；每次真实续流向 live Session 追加一个**已知惰性**事件 `hook/invoked`
  （`data.name='resume-stream-cut'`，带 provider / code / count / turn）。
  不能用自定义事件类型——dsh-session 的持久化桥直接落盘每个 session/event，loader
  拒收未知类型会让整个会话"历史加载失败"（SessionFormatUnsupportedError），即砖化。
- **Client 半**（`lib/client.js`）：向 `conversationEvents` 注册一个 Definition
  （`match` 只认自己的事件、其余全部放行），并向 `conversation.chat.node` slot 注册
  按 kind 匹配的渲染器。徽章由 DSH 官方会话管线内联渲染；事件本身已持久化，所以
  刷新页面 / 历史重载后徽章照常恢复显示。
- **计数**：尽力持久化到 `.dsh/resume-stream/count.json`（旧版根级
  `.dsh/resume-stream-count.json` 首次启动自动迁移；读写失败不影响续传功能）。加载完成前发生的续流不会覆盖旧计数。
- **日志**：`.dsh/resume-stream/resume-stream.log` 只记录启动 / 续流 / 失败三类事件，
  不记录每次请求流量；超过 256KB 自动轮转为 `resume-stream.log.old`（最多保留一代）。

## 已知限制

- 自动接续的合成 user 消息会作为一条普通用户消息显示在会话里（带 `[resume-stream]`
  前缀，来源标记为 plugin）——这是接续机制的工作方式，同时起到向用户说明"为何自己
  继续跑了"的作用。
- 若切断发生在工具调用进行中，已排队工具调用的收尾由下一轮的模型自行判断处理；
  极少数情况下可能需要人工补一句。
- 同一轮多次断流会各显示一枚徽章（如实反映断流次数，正文带累计 ×N）。

## 安装（DSH profile bundle）

```bash
# 从 GitHub Release 安装 tgz（发布后给出具体链接）
dsh plugin --profile web add <tgz-url>
# web 插件需重启 DSH 生效（会结束当前会话）
```

## 参考

上游 [llt22/dsh-opencode-zen-compat](https://github.com/llt22/dsh-opencode-zen-compat)
对 opencode 系路由实现了同样的块改写（仅限 opencode 作用域、无 UI）；本插件去掉了
作用域限制（全 provider 生效），并补上了"仅续流轮次显示"的内联徽章与累计计数。
