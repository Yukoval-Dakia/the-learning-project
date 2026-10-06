# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07：[本机发布记录](docs/planning/2026-10-07-local-release-result.md)已保存；现有版本升级完成，Copilot 实际回答因旧 provider 余额不足失败，正在修复。完整目标与[自主交付授权](docs/planning/2026-10-07-autonomous-delivery-charter.md)继续有效。[原 main 看板](docs/planning/2026-10-07-delivery-baseline-snapshot.md)保留历史证据。

## NOW

- **YUK-1103 自主交付**：单条活动线为本机日用验收与 AI 帮助恢复。http://localhost:8787 运行 main `5d738dbc0`；app/worker healthy、115项迁移、readiness active，最终停写备份恢复与副本原生结算验证通过。不要重复部署旧版本。
- **YUK-1341 Copilot 阻塞 / PR1582**：MiMo2.6Pro 隔离能力实证和证据修正已通过最终验证审。CI 两项高危依赖已更新为 sharp0.35.5 / MCP SDK1.32.1；本机依赖审计、52项聚焦测试、实际图像处理和MCP通信、静态检查与构建通过，等待新head完整CI。生产仍因旧Xiaomi402无法回答，产品AI路由暂保留，不能称已恢复日用。
- **YUK-1340 会话入口**：独立工作树正在修复默认选中已结束会话导致输入禁用，须保留历史只读与显式新对话，并完成真实组件及浏览器验收。
- **工作模型**：后续子任务使用 `opencode / opencode-go/mimo-v2.6-pro`，自动任务提示已更新。父线程切换曾中断且未保持，不能声称已经全面生效；MiMo 子任务已完成并读取真实截图，父线程核对了可见细节。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)由 agent 在持续委托下采用并负责验证，连接学校、纸笔、自习与数字工具，不是已实现清单。
- **技术目标 / YUK-1337**：[ADR-0066](docs/adr/0066-typescript-adaptive-learning-architecture.md)保留 TanStack Start + Pi + PostgreSQL/Drizzle + DBOS 方向；当前仍为 Hono + Vite + pg-boss。

## NEXT

- 修复 Copilot 实际回答阻塞，验证真实工具与图像能力、费用和失败恢复；再以椭圆学习场景验收记录、状态、后续安排与再次验证的衔接。
- YUK-1042 按已有副作用和幂等身份恢复38条 DLQ，不能清空或当作升级新增。
- YUK-1338 目标架构集成保持 Backlog，单独证明状态版本、过期结果拒绝与重启恢复。

## PARKED

- YUK-1342：付费探针显式运行开关与不可覆盖封存，初审成组 P2；本轮不扩张能力接线改动。

- YUK-1329 保留通用发布入口和故障注入验收；一次手工安全发布不关闭整票。旧镜像直接回退兼容性未验证。
- 其他线程 YUK-1325 / PR #1580 独立推进，不接管其工作树。其他历史事项见原看板和 Linear，不批量标 Done。
- `pi-durable` 不作为已选持久化基础，不与 DBOS 同时拥有同一循环恢复；现有确定性功能及费用、重试、并发、恢复测试保留。

## BLOCKED-ON

- 无需 owner 追加日常授权。旧 Xiaomi 余额不足是当前已证实的 AI 调用阻塞；不自行开新订阅。工作模型已切换不代表产品路由获准切换，后者暂保留。
- 每小时任务已唤起原线程，下一次按 T3 返回时间执行；依赖本机/T3运行。完整无人值守交付尚待实际证明。
