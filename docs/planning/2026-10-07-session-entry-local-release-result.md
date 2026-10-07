# Copilot 会话入口本机发布记录

2026-10-07 02:17Z 发布，02:20Z 完成验收。本文记录 YUK-1340 的实际交付，不代表完整连续学习产品已经完成。

## 现在可用的行为

打开 Copilot 时，会根据刚取得的服务端时间和会话状态选择可继续的对话。主动查看已结束记录时保持只读，并显示“开始新对话”。本机真实浏览器通过了默认续接、历史只读、新建空会话、关闭重开、刷新后选回同一会话及输入检查。浏览器使用实际 API 和生产数据库，没有响应替身；只输入后清空，没有发送消息。

- 本机：http://localhost:8787。
- 远程：https://loom-mac-mini.tail2ee344.ts.net/，同一 tailnet，使用原 Loom 访问令牌。
- app/worker：`f3bfff2cfe2aea0efbf7d11ead8a84ebfab497ef`，镜像 `the-learning-project-app:f3bfff2cf`。
- ARM64 镜像 ID：`sha256:e681a7b502aa6a370b572edfb3ebef7a559c8d09df841d4e7361838598d2fbb1`，revision label 与源码一致。
- app、worker、Postgres 均 healthy；readiness 为 `assessment-contract-v1 / active`。数据库沿用原卷，115 项迁移。
- app/worker 的产品路由均保持 `opencode-go / mimo-v2.6-pro`。本次没有修改模型接线或提示词，没有新增模型请求和费用。

## 发布与验收依据

[PR #1583](https://github.com/Yukoval-Dakia/the-learning-project/pull/1583) 在 exact head `d3906a701f` 的 CI Gate [37556260516](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/37556260516) 成功、已发 P0/P1 裁决及最后推送超过 17 分钟后，于 02:05:19Z 合并为当前源码。两轮代码审查预算已用完，没有启动第三轮。既有 scoped 单元、DB、构建页面及静态检查记录见[入口证据](2026-10-07-yuk1340-copilot-session-entry-evidence.md)。

父线程以合并后的准确镜像恢复生产副本，运行完整 migrator，再用真实 Chromium 验收。T3 preview 的 status/open 都明确返回无 automation host，才使用本机浏览器替代。首个副本 driver 把正常的 brief-view 观测 POST 误当作非预期写入，失败记录保留；核对确定性 handler 后修正 driver，副本和生产均通过。没有改变产品源码来通过检查。

生产验收只新增一条空会话 `xxak5cency8qusv67374qmpd`，未向模型提交文字。实际 SQL 仍为 2,712 条 AI task run、2,744 条 event；停写后至验收没有新的 AI task run。实际页面的 JS/CSS 内容与发布构建一致。截图和请求路径保存在私有发布目录。

本机及 Tailscale HTTPS 的 health/readiness 均 200；业务 sessions 无令牌 401、有令牌 200，并返回 `server_time`。这是从当前 Mac 的网络检查，尚未替代 YUK-1344 的离家实体设备验收。

## 停写、备份与数据保留

app/worker 在 02:15:08Z 停止，02:15:12Z 确认无其他数据库客户端。最终备份均在此之后完成。

- PostgreSQL dump：10,784,347 bytes，SHA-256 `537954657ecc296464c28728a02729a95f1d418ff438bec39d52b3502d6632d4`。实际恢复成功；99 张普通表及 2 个分区父表的行数与停写时一致，115 项迁移、2,744 条 event。
- Mem0 worker 卷已归档，恢复出的 SQLite `integrity_check=ok`。旧 app 容器中 `/tmp/mem0` 不存在，已记录实际检查结果；没有遗漏一个已存在的 app history 文件。
- R2 在 02:15:19Z 至 02:15:48Z 保存 63 个对象、7,961,112 bytes，逐对象校验内容散列。没有远端写入或删除。
- 原 42 failed + 42 DLQ 在 worker 启动后逐条完整 JSON 比较一致，包括身份、状态、重试次数和执行时间。没有清队列或重放。
- 生产 migrator 成功后，02:17:16Z 启动 worker，02:17:28Z 启动 app。原 PG 和 Mem0 卷保留。

本轮没有执行旧 backup helper 的自动清队列说明或采纳其历史处置清单。YUK-1329 的通用工具问题仍开放。本轮自身的备份顺序和恢复依据完整，不能把它外推为通用发布工具已经修复。

## 回退与运维指针

当前私有发布目录为 `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-session-entry-20261007-f3bfff2c`。上级 `current-release.json` 已更新；`release-result.json`、`evidence/`、`final-backup/` 保存详细证据与私有数据，不提交仓库。发布互斥锁已释放。本轮两个恢复容器和两个副本应用已停止并保留。

旧镜像 `the-learning-project-app:0f81e198f` 已归档为 `previous-image.tar.gz`，405,992,501 bytes，SHA-256 `ce0f8a7afe87469b4cc38e59654936cdb963b75cb3a56708f15292faccfcb79a`；配置为 `compose.previous.private.json`。独立旧镜像应用读取了新 migrator 处理后的副本，readiness、会话列表和新版本创建的空会话历史均 200。源码没有新增 schema/migration。

需要应用回退时使用上述旧镜像和配置，显式设置 `TLP_IMAGE=the-learning-project-app:0f81e198f`，仅重建该项目的 worker/app；浏览器必须刷新以同时回到旧 SPA，因为新 SPA 需要旧 API 没有的 `server_time`。此方式保留回退前的新数据库写入，也会恢复旧会话入口缺陷。该兼容证据来自副本，没有在生产执行回退。不得自动覆盖生产数据库；若需要数据恢复，必须先处理备份后的新写入。不得运行 `down`、`--remove-orphans` 或删除卷。

## 未完成的边界

YUK-1343 的“失败创建提前改变选择来源”和“50 条历史截断隐藏可续接会话”已按 P2 策略延期，未在本发布修复。YUK-1346 的单次“不写入记忆”控制尚未实现，后续优先落实它，才能可靠承接用户对恰当记录和用途边界的要求。

产品 AI 的既有实际输出及费用限制仍以[MiMo 发布记录](2026-10-07-mimo-local-release-result.md)为准，尤其记忆探针整体仍未通过完整 wire/cost 观测。没有因为本次 UI 验收而新增模型质量或评分准入结论。下一条产品线继续围绕真实学习过程、帮助程度、独立迁移及后续复验推进。
