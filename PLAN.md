# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07：本工作树活动线为 YUK-1340 / PR1583 retained automatic selection P1 修复。实际组件、API/DB、本机制品浏览器证据与生产验收分开报告；父线程负责推送、CI、review处置与发布。

## NOW

- **YUK-1103 自主交付**：父线程当前交接确认 PR1585 已于00:25Z合并为 `0f81e198f`，09:30JST完成本机部署；app/worker MiMo healthy，真实Copilot两轮/刷新与memory brief通过。本writer未重验生产；旧 `5d738dbc0` 记录是历史，不重复部署。发布closeout文档由父线程在独立1341树准备。
- **YUK-1341 产品 AI 切换**：PR1585已合并并由父线程部署；保留main产品MiMo接线、专用embedding/typed/OCR与既有评分slice准入边界。本树只普通merge集成，不新增产品AI改动或实际付费探针。源码历史证据见[迁移说明](docs/planning/2026-10-07-yuk1341-product-mimo-routing.md)，当前发布状态依父线程closeout。
- **YUK-1340 / PR1583（当前交付）**：修复提交 `ac9ab2ad1` 为每次drawer open等待成功fresh sessions，并用server_time重验自动选择/创建的24h资格。显式历史/新建和原pending/run恢复保留；135UI、37DB、36自有build浏览器与static/build/架构门禁通过，见[证据](docs/planning/2026-10-07-yuk1340-copilot-session-entry-evidence.md)。普通merge `origin/main` 后相关181唯一unit、37DB、36browser与static/build再次通过；review r1+r2预算用尽，不开第三审；仍待父线程push/exact-head CI、review处置、合并与生产验收。
- **开发模型与产品模型**：开发代理按AGENTS常规Sol6.1 high；产品AI目标为OpenCode Go MiMo2.6Pro。旧dev-only范围解释已作废。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)由 agent 在持续委托下采用并负责验证，连接学校、纸笔、自习与数字工具，不是已实现清单。
- **技术目标 / YUK-1337**：[ADR-0066](docs/adr/0066-typescript-adaptive-learning-architecture.md)保留 TanStack Start + Pi + PostgreSQL/Drizzle + DBOS 方向；当前仍为 Hono + Vite + pg-boss。

## NEXT

- 父线程集成YUK-1340最终提交，完成exact-head CI、既有P1线程处置与最后push后17分钟窗，再合并/发布和真实Copilot入口验收；发布后继续完整椭圆学习场景。
- YUK-1042 按已有副作用和幂等身份恢复38条 DLQ，不能清空或当作升级新增。
- YUK-1338 目标架构集成保持 Backlog，单独证明状态版本、过期结果拒绝与重启恢复。

## PARKED

- YUK-1343：创建失败恢复、显式创建竞态与消息隔离的持续回归已补充，不以本次局部覆盖关闭既有follow-up；状态由父线程对齐。
- YUK-1345：视觉校准同源推断仍可能优先采用旧VISION_JUDGE_PROVIDER；独立初审P2跟进，未修复，不把同一MiMo输出宣称异源证据。

- YUK-1342：付费探针显式运行开关与不可覆盖封存，初审成组 P2；本轮不扩张能力接线改动。

- YUK-1329 保留通用发布入口和故障注入验收；一次手工安全发布不关闭整票。旧镜像直接回退兼容性未验证。
- 其他线程 YUK-1325 / PR #1580 独立推进，不接管其工作树。其他历史事项见原看板和 Linear，不批量标 Done。
- `pi-durable` 不作为已选持久化基础，不与 DBOS 同时拥有同一循环恢复；现有确定性功能及费用、重试、并发、恢复测试保留。

## BLOCKED-ON

- 无需owner追加日常授权。YUK-1340本writer的授权截至本地commit与普通merge origin/main，不得push、PR watch/comments/merge、生产操作、付费调用、Linear或嵌套delegation；这些后续门禁由父线程负责。
- 每小时任务已唤起原线程，下一次按 T3 返回时间执行；依赖本机/T3运行。完整无人值守交付尚待实际证明。
