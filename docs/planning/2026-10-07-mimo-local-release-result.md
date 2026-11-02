# 2026-10-07 MiMo 产品 AI 本机发布

Loom 已在这台 Mac 运行 `0f81e198f2b2cf51bdc5df231e3b7e5fbba06ad4`。app、worker 都固定为 `opencode-go / mimo-v2.6-pro`。生产浏览器完成了两轮假设椭圆学习辅导，刷新后仍能读取两轮回答；旧 Xiaomi402 不再阻塞这条路径。完整连续学习产品仍未完成。

入口：<http://localhost:8787>；远程 <https://loom-mac-mini.tail2ee344.ts.net/>。远程设备须在同一 tailnet，沿用 Loom 访问令牌。Tailscale Serve 为私有 HTTPS，没有开启 Funnel；Mac 需开机且用户会话内 daemon 运行。尚未从离家实体设备验收，见 YUK-1344。

## 制品和发布门禁

- [PR #1585](https://github.com/Yukoval-Dakia/the-learning-project/pull/1585) 在 2026-10-07 00:25:11Z 合并；初审无 P0/P1，既有 P2 已裁决，并满足最后 push 后17分钟等待窗。
- exact head `6ca8d8f3cd7c0694c12fd06230d540dac1aa6da5` 的 [CI Gate 37548065515](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/37548065515) attempt 2 成功。第一次 usability 已输出36 pass但未退出而超时；本机同范围36 case退出成功，重跑失败 job 后 CI 成功，未用延长超时掩盖问题。
- ARM64 镜像 `the-learning-project-app:0f81e198f`，image ID `sha256:64b568db760de76c22f29edc72b39ee67e3f8e21c679cf02d0c9aa33c3b18906`。revision label 与 merged main 一致。
- worker 于00:30:18Z、app 于00:30:19Z恢复。两者和原 PostgreSQL healthy；115项迁移、`assessment-contract-v1/active`。readiness 是基础设施证据，不是学习功能验收。
- merged main 与 candidate 的 server、worker、migrate 和 SPA index 四个产物 SHA256 相同，见[净化证据](evidence/2026-10-07-mimo-local-release.json)。副本验证运行于 candidate，生产辅导运行于 merged image；不混写为同一次验收。

## 数据和恢复

私有运行目录为 `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-mimo-20261007-0f81e198/`。其上级 `current-release.json` 指向本次 Compose 和 `release-result.json`。包含凭据、附件及用户数据的私有文件不得提交或打印。

先对恢复副本运行最终镜像 migrator，再停 app/worker、确认其他 DB client 为零、取得最终 DB 与 worker Mem0 history 备份，恢复验证后迁移生产。最终 dump 10,576,393 bytes，SHA256 `5c25a54c716bbf88aae9229ad4f2b32c80b65021ad01363fe1861f847e459ddb`。隔离恢复115项迁移、2,735 events；独立核验99张表计数一致。Mem0 history archive 61,440 bytes；旧镜像及配置已留存。

R2 的63对象快照共7,961,112 bytes，于00:28:11.796Z完成，早于00:28:19.302Z停写确认约8秒。独立核验指出时序缺口后，父线程在00:43:15Z重新读取全部对象：key集合、内容 SHA256、大小、ETag、LastModified 全部一致，最后修改时间最晚为9月14日。因此现有附件内容与快照一致；此为发布后的补证，不改写为停写期间抓取。原快照与补证均保留。

42 failed 和42 DLQ 的状态、重试数及执行时间与备份一致；没有清空或重放。旧 cutover helper 生成的 `OWNER-ACTIONS.txt` 与 strict manifest 带有 auto-purge 指示、7条旧处置和8条 census mismatch，不能作为当前操作授权或完整一致性证明；以 `backup-attestation.json` 和本次保留策略为准，修复归 YUK-1329。没有执行这些 purge 指示。

旧镜像单独回退兼容性没有新验证。旧配置也会恢复 Xiaomi402 故障；需要回退时先验证兼容，并保留备份后的新写入，禁止自动覆盖生产 DB。私有 Compose 仅管理 app/worker/migrate；禁止 `down`、`--remove-orphans` 和 `down -v`。两台本次恢复演练容器已停止保留，部署锁00:45:46Z释放。

## 真实行为和费用

| 证据层 | 已观察结果 | 限制 |
| --- | --- | --- |
| 恢复副本原生学习 | 发卷201、无效作答422、advice200、activation applied、重复请求 idempotent_replay；SQL仅一条结算及一次 FSRS 更新 | 确定性题目；不是全部练习页面或模型评分准入 |
| 生产浏览器 Copilot | 显式新对话后两轮202均成功；第二轮记得椭圆场景，建议第一步卡住时分步对照；刷新后两轮文字一致，无 page error | 自动会话入口 P1 仍由 #1583 修复；本次没有掩盖成已修 |
| 生产 API/DB | session `h2ech9r3vwb0j4ej6hy5z1cw` 保持 `pi:be7d8c1d-56ee-44dc-ba4d-f2bfa8d5f739`；2 ask/2 reply，均 MiMo2.6Pro success，无 tool call 或掌握/计划改写 | 假设场景明确标为上线验收；回答不是掌握证据，也没有验证独立迁移能力 |
| 生产后台记忆 | 截至封存，3项 MemoryBriefTask success，均 MiMo2.6Pro；opaque Mem0 操作成功，2个 direct reconciliation wire 记录为目标pair | opaque记录仍为mem0/model=null，SDK wire/count/cost不完整，不冒充逐请求模型证明 |
| HTTPS/鉴权 | 本机与 tailnet health/readiness200；业务 `/api/copilot/sessions` 无令牌401、有令牌200 | readiness本身按实现公开，不用它证明鉴权；实体远程设备未验收 |

两轮 Copilot task run 尾缀为 `d362b0046d84f929ae4a1aa639bfbd3c8caa03c84592de38b475ca8ca6bca0cc` 和 `363a380b31dae526a7dbc24b1ffa4c5bed20084db436459b0370c8f7434adfa7`，完整ID见证据。Pi catalog estimated分别 `$0.001417462`、`$0.001326547`，合计 `$0.002744009`。加上上述3项自然后台摘要，已知估值快照为 `$0.017686259`；这不是账户账单或本次全部费用，Mem0/直接调和仍 unknown。后台沿用现有产品任务预算，不声称验证脚本覆盖所有后台费用。

首个浏览器脚本在202后读取 response body 失败；查 DB 确认第一轮已成功，未重发。第二个恢复脚本漏采 URL query，于新增请求前停止；修正后接续原会话，只发送原计划的第二轮。两个失败脚本和结果保留，不能把恢复过程说成首跑全绿。

副本记忆验收使用真实抽取、DashScope1024D向量、SQLite ADD、KEEP_BOTH/human_approval_required WAL 和 canonical readback，功能成功。**整体 probe 仍为 FALSE**：OpenAI4 node-fetch 绕过 global-fetch wrapper，SDK extraction/embedding wire计数缺失；费用未知，保守预留$2，未付费重跑。YUK-1342跟进。其 source candidate 与本次四个运行产物相同，但它并非在生产执行。

## 发布后发现的行为缺口

2026-10-07 01:15Z 只读复查确认：上述两次验收请求虽然明确要求“不写入记忆”，异步 Mem0 仍各保存了一条摘要。摘要正确描述假设验收，没有被误写为实际掌握或计划变化；但单次不记忆选择尚未约束后台长期派生。已去重登记 [YUK-1346](https://linear.app/yukoval-studios/issue/YUK-1346)，原记录和私有证据保留，未删除或重放。这不改变模型路由成功的事实，也不能把记忆任务成功称为记忆控制已经实现。

## 下一条交付

YUK-1341 的产品模型配置和本机辅导恢复已交付；54聊天消费者的源码覆盖不等于54项质量验收。专用 embedding、typed Jev、OCR协议仍保留，评分切片的 admission/withheld 不放宽。

YUK-1340 / #1583 保持活动：修复自动选择过期会话、默认已结束会话入口及与新 main 的冲突，保留显式历史选择和待恢复请求。修复已由writer交回并通过父线程组件、DB及构建页面验收；仍待新exact-head CI、合并窗与生产发布验收。随后用真实椭圆学习过程验证证据记录、帮助程度和后续复验安排。单次建议中的“能复述”仍不能替代独立迁移表现，完整行为基线继续由 YUK-1103/YUK-405 推进。
