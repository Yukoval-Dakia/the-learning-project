# YUK-948 / YUK-950 — 统一持续会话验收

已交付：[PR1346](https://github.com/Yukoval-Dakia/the-learning-project/pull/1346)，
exact `cd1f7c54916c4d75dc1b64f29be2ec3fd1d363d9` 的
[CI34050991978](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/34050991978) 全绿。
独立初审与 test-only 修复的唯一复核均 PASS；已于 2026-09-06T18:24:16Z squash 合并至
`9ebee3aebe4c2840120d577bdf08512dfc3596e6`。未部署。后继结构退休见 YUK-965。

## 产品边界

Owner 已批准现有 Copilot drawer 的发送、恢复和消息展示改动。消息不再分前后台：
`POST /chat` 统一持久接纳，同会话 FIFO，关闭/刷新/切换会话只取消订阅；显式 Stop
作用于选定 run。运行中可继续发送，不要求先停止，也不返回 session busy。

服务端是已接受运行的唯一真相源。浏览器只保存尚未跨过 202 边界的原 key/body，
不以单个 latest handle 代替会话。回复 `run_id` 来自同会话 ask/chip 因果根，
与 `checkpoint_event_id` 的撤回资格独立。教学题目与回复原子提交、安全校验、
工具与子任务展示、成品卡片和模式明确结束协议均保留。

实现已集成：后端主线、UI `6895c4f5` → `b92177f86`，root 修正自动合并产生的
重复类型字段。默认仍 6 模型轮 / 25 工具调用，原累计读取量上限不变；持久执行
不重置预算。原生 SDK 只恢复当前 worker 确实拥有且已提交相同终文字节的会话。

## 本地证据

- 108 UI unit：乱序 202、多消息、等待轮 Stop、全量快照恢复、过期快照竞态、
  延迟 202 跨会话隔离、断线仅重连、原 key/body 重试、认证失败、持久回复去重。
- 27 历史 DB：`run_id` 合法根、chip/教学与撤回资格分离、跨会话/非输入父事件不关联。
- 82 scoped DB：API 合同、FIFO、worker、教学、Stop；后续自动 poller 版本 queue 8/8。
- 自动 poller 用生产 registrar + Copilot manifest 声明：已提交终态的 head 自动完成，
  后继 Stop 请求自动结算，两物理 job 均 completed，模型入口 fail-closed 且零调用。
- 构建后浏览器 7 个 Copilot 场景：连续发送、停止等待轮不误停首轮、关闭与清空
  sessionStorage 后恢复、原 key/body 歧义恢复、四类 primary view 与 replay、明确模式结束。
  API 被确定性夹具拦截，这是生产 bundle 的浏览器行为证据，不冒充真实模型 E2E。
- 完整既有 shipped-browser smoke 20/20，typecheck、lint（仅既有 warning）、build、
  capability/architecture/control-plane/API 合同检查通过。

独立初审对 exact `70189a91` PASS，无 P0/P1。PR1346 首轮 CI `34050192068` 的
DB2 揭示测试清理泄漏：queue suite 留下一个等待轮，后续 global backlog 计数 4≠3。
两文件单 fork 串行复现，修复仅清理 queue suite 自己的 physical jobs + job_events，
不改生产计数、不放宽旧断言，同一串行 9/9 GREEN。最终 exact-head CI 通过前不得标为交付；未部署或操作生产库。

## 真实模型与成本

详见 [实际输出证据](evidence/2026-09-07-unified-conversation-actual.json)：
实际 HTTP → pg-boss fetch → production handler 两轮，进度订阅断开后仍完成；
同 SDK session cold → resume，保留零/未知、有向关系、未批准状态并读取更新上下文。
该付费样本不是自动 poller；自动 poller 另由上述零付费真实 DB 场景验证。

本次公开费率 estimated USD 0.0007353978，保守 reserve USD 1.6。
新 USD 10 池累计 estimate 0.0352456927，reserve 5.30823，安全剩余 4.69177；
旧池 0.28771982 单列，历史未知费用仍未知。估算不是账户账单。
输入 13203 → 13370，不声称此样本减少 token；没有为 UI 验证新增付费调用。

## 测试精简与后继

删除旧 inline `/chat` SSE、单例 latest-handle 与 transport-owned Stop 的专属测试，
因为相应产品调用方已经退休；以持久入口的状态/竞态/恢复测试替代，不删除安全行为。
架构 audit 439/0/47 保留一个必要的 session-owner 调用，不用浅转发隐藏依赖数字。

去重后新增 YUK-965：`runCopilotChatImpl` 与 foreground policy 仍被旧 actual harness
直接消费，已无产品调用方。后继迁移有效实际验收到持久 owner 后删除该旧适配器，
保留共享写入、教学、成本、恢复与权限保护。该结构残留意味着整个重构 goal 尚未完成。
