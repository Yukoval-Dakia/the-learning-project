# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07：owner 将产品决定、实现及本机部署运维交由 agent 持续执行，后续主要提供使用建议。[授权与每小时任务](docs/planning/2026-10-07-autonomous-delivery-charter.md)已建立；调度启用不等于完整产品已交付。[原 main 看板](docs/planning/2026-10-07-delivery-baseline-snapshot.md)保留各线历史证据。

## NOW

- **YUK-1103 自主交付与本机运维**：当前一条执行线为恢复可重复的本机发布，随后用真实学习行为验证产品。每小时任务绑定 T3 线程 `57961995-70c3-4121-a9dd-97d90471be1a`，首次计划 2026-10-07 01:03:22 JST。不得重复启动同一发布或抢写其他工作树。
- **行为基线 / YUK-405**：[连续学习系统设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习和数字工具；agent 在持续委托下采用并负责细化、验证，不再等待 owner 逐项审阅。它不是已实现清单。
- **本机实查**：原 app/worker 为 9 月 28 日镜像且无 revision，数据库112项迁移；`/today`令牌登录成功，无页面/API错误。10月6日日备份在隔离PG恢复成功，2626条event、112项迁移。latest main `5d738dbc0`镜像构建与115项迁移预演进行中，尚未升级生产。
- **YUK-1329 发布缺口**：已确认旧Compose引用的 `/tmp/docker-compose.deployfix.yml`丢失，已保留实际运行配置与私有恢复副本。完整发布入口及故障注入验收仍未完成，跟进留既有票。
- **技术目标 / YUK-1337**：[ADR-0066](docs/adr/0066-typescript-adaptive-learning-architecture.md)保留 TanStack Start + Pi + PostgreSQL/Drizzle + DBOS 的已批准方向。main已占用0065，整合时仅更正编号。当前仍是 Hono + Vite + pg-boss，架构迁移尚未实施。

## NEXT

- 完成新版本在恢复副本上的迁移与浏览器检查，核对模型配置和旧任务义务；最终备份后执行本机部署，保存镜像SHA、恢复位置与实际行为证据。
- 以“椭圆难题做完仍不稳固”检验记录、状态判断、后续安排和再次验证的衔接，将真实缺口去重写入Linear并实施。确定性工具保留，不能用部署成功替代学习效果验收。
- YUK-1338 技术集成验证保持Backlog；按已批准目标开展时单独建立兼容与恢复证据，不把框架替换当产品完成。

## PARKED

- 其他线程的YUK-1325 Laminar / PR #1580独立推进，不接管其工作树或重复实施。已合并SCF与评分入口等变更的证据保留原看板快照与Linear；合并不代表已部署。
- YUK-1007 设置范围、YUK-1042 DLQ、YUK-766恢复等未完成项以当前Linear为准，不因本轮接管批量标Done。
- `pi-durable` 不作为已选持久化基础，不与DBOS同时拥有一个循环的恢复；现有模型计费、重试、并发和回滚测试保留。
- 历史看板中的暂停或未验证事项不自动变成已完成；相关决定在具体产品工作中复核。

## BLOCKED-ON

- 当前无需 owner 追加授权。部署尚待构建、迁移预演、恢复/兼容检查和真实验收通过；这些是未完成的验证，不是等待用户批准。
- T3 preview明确无自动化host，本轮采用已安装Playwright浏览器验收。自动任务依赖本机与T3调度运行环境可用；首次自动执行仍待记录。
