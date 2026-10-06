# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07：PR1582 已合并 main `8a5379285`；会话入口修复通过父线程组件/浏览器验收与独立初审，待本 PR 的 CI、合并与本机发布。[本机发布记录](docs/planning/2026-10-07-local-release-result.md)仍对应 `5d738dbc0`，旧 provider 402 未恢复。完整目标与[自主交付授权](docs/planning/2026-10-07-autonomous-delivery-charter.md)继续有效。[原 main 看板](docs/planning/2026-10-07-delivery-baseline-snapshot.md)保留历史证据。

## NOW

- **YUK-1103 自主交付**：单条活动线为本机日用验收与 AI 帮助恢复。http://localhost:8787 运行 main `5d738dbc0`；app/worker healthy、115项迁移、readiness active，最终停写备份恢复与副本原生结算验证通过。不要重复部署旧版本。
- **YUK-1340 会话入口（当前交付）**：默认续接 active/idle 且在 24h 复用窗口内；只有过期候选时创建新对话；显式历史保持只读并提供新建入口，迟到创建不抢选择。初版 117 项组件测试通过后，初审 P1（bootstrap 遗漏 24h 年龄检查）已修复：新增共享常量 `session-reuse.ts` + 7 条冻结时钟组件测试（124 项全过），typecheck/lint/build 通过。见[验收证据](docs/planning/2026-10-07-yuk1340-copilot-session-entry-evidence.md)。P1 修复**尚待父线程独立核验、唯一验证审（P0/P1）与新 exact-head CI**；须经 17 分钟等待窗、合并与实际本机发布，不能称生产已修复。
- **YUK-1341 Copilot 阻塞 / PR1582**：MiMo 工具能力与证据修正已合并；sharp0.35.5 / MCP SDK1.32.1 的相关实际消费者、本机检查及 exact-head CI 通过，审查和等待窗完成。能力准备不改变生产路由；旧 Xiaomi 402 仍未恢复，整票保持 In Progress。
- **工作模型**：后续子任务使用 `opencode / opencode-go/mimo-v2.6-pro`，自动任务提示已更新。父线程切换曾中断且未保持，不能声称已经全面生效；MiMo 子任务已完成并读取真实截图，父线程核对了可见细节。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)由 agent 在持续委托下采用并负责验证，连接学校、纸笔、自习与数字工具，不是已实现清单。
- **技术目标 / YUK-1337**：[ADR-0066](docs/adr/0066-typescript-adaptive-learning-architecture.md)保留 TanStack Start + Pi + PostgreSQL/Drizzle + DBOS 方向；当前仍为 Hono + Vite + pg-boss。

## NEXT

- 修复 Copilot 实际回答阻塞，验证真实工具与图像能力、费用和失败恢复；再以椭圆学习场景验收记录、状态、后续安排与再次验证的衔接。
- YUK-1042 按已有副作用和幂等身份恢复38条 DLQ，不能清空或当作升级新增。
- YUK-1338 目标架构集成保持 Backlog，单独证明状态版本、过期结果拒绝与重启恢复。

## PARKED

- YUK-1342：付费探针显式运行开关与不可覆盖封存，初审成组 P2；本轮不扩张能力接线改动。
- YUK-1343：会话创建失败后的重开语义、显式创建竞态与消息隔离持续回归，初审成组 P2；当前可见新建按钮可手动重试，不阻塞入口修复。
- YUK-1329 保留通用发布入口和故障注入验收；一次手工安全发布不关闭整票。旧镜像直接回退兼容性未验证。
- 其他线程 YUK-1325 / PR #1580 独立推进，不接管其工作树。其他历史事项见原看板和 Linear，不批量标 Done。
- `pi-durable` 不作为已选持久化基础，不与 DBOS 同时拥有同一循环恢复；现有确定性功能及费用、重试、并发、恢复测试保留。

## BLOCKED-ON

- 无需 owner 追加日常授权。旧 Xiaomi 余额不足是当前已证实的 AI 调用阻塞；不自行开新订阅。工作模型已切换不代表产品路由获准切换，后者暂保留。
- 每小时任务已唤起原线程，下一次按 T3 返回时间执行；依赖本机/T3运行。完整无人值守交付尚待实际证明。
