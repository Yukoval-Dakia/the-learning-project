# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07：本工作树活动线为[YUK-1341 产品 AI 迁移](docs/planning/2026-10-07-yuk1341-product-mimo-routing.md)，owner已纠正统一的是产品内部AI。源码、本机证据、CI和部署分开报告；父线程负责集成和发布。

## NOW

- **YUK-1103 自主交付**：单条活动线为本机日用验收与 AI 帮助恢复。http://localhost:8787 运行 main `5d738dbc0`；app/worker healthy、115项迁移、readiness active，最终停写备份恢复与副本原生结算验证通过。不要重复部署旧版本。
- **YUK-1341 产品 AI 切换**：此树源码commit `14cb6b326` 已完成54聊天task + Mem0抽取/调和接线；388unit、31scopedDB、4次MiMo实际输出、static/build/audits通过。实际费用Pi估值$0.001130681 + 两项memory unknown，总保守占用$1.50113≤$3；仅封存净化输出。父线程接续独立review/CI/集成/发布，生产旧5d738dbc0未改。专用embedding/typed/OCR保留，评分slice准入不放宽。
- **YUK-1340 会话入口**：独立工作树正在修复默认选中已结束会话导致输入禁用，须保留历史只读与显式新对话，并完成真实组件及浏览器验收。
- **开发模型与产品模型**：开发代理按AGENTS常规Sol6.1 high；产品AI目标为OpenCode Go MiMo2.6Pro。旧dev-only范围解释已作废。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)由 agent 在持续委托下采用并负责验证，连接学校、纸笔、自习与数字工具，不是已实现清单。
- **技术目标 / YUK-1337**：[ADR-0066](docs/adr/0066-typescript-adaptive-learning-architecture.md)保留 TanStack Start + Pi + PostgreSQL/Drizzle + DBOS 方向；当前仍为 Hono + Vite + pg-boss。

## NEXT

- 父线程独立review、exact-head CI、集成后以freshbackup/restore证明发布前提，同时设置app/worker产品pair。部署后验证Copilot、评分和记忆实际路由与恢复，再推进完整椭圆场景。
- YUK-1042 按已有副作用和幂等身份恢复38条 DLQ，不能清空或当作升级新增。
- YUK-1338 目标架构集成保持 Backlog，单独证明状态版本、过期结果拒绝与重启恢复。

## PARKED

- YUK-1342：付费探针显式运行开关与不可覆盖封存，初审成组 P2；本轮不扩张能力接线改动。

- YUK-1329 保留通用发布入口和故障注入验收；一次手工安全发布不关闭整票。旧镜像直接回退兼容性未验证。
- 其他线程 YUK-1325 / PR #1580 独立推进，不接管其工作树。其他历史事项见原看板和 Linear，不批量标 Done。
- `pi-durable` 不作为已选持久化基础，不与 DBOS 同时拥有同一循环恢复；现有确定性功能及费用、重试、并发、恢复测试保留。

## BLOCKED-ON

- 无需 owner 追加日常授权。旧 Xiaomi 余额不足是当前已证实的 AI 调用阻塞；不自行开新订阅。产品迁移已明确授权，当前部署仍为旧5d738dbc0且未设pair，不能把本树源码或小样本输出当成已发布。
- 每小时任务已唤起原线程，下一次按 T3 返回时间执行；依赖本机/T3运行。完整无人值守交付尚待实际证明。
