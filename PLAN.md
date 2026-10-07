# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07 owner 更新：先完成整个非 UI 迁移，UI 暂缓，再完成 Linear 残留功能。结构清理与可维护性纳入验收，见[最新优先级](docs/planning/2026-10-07-non-ui-migration-priority.md)。当前部署仅供 Agent 测试。

## NOW

- **YUK-1376**：PR1600准确运行候选 `1bd0263e5` / ARM64 image `8c7d64632ebdf1b4ea6b99501f06caf88e696bf2b02a526ef121e4bafd3e73b3` 已完成隔离材料HTTP验收：4条保留错题共9 GET，完整inline passage和available figure精确字段、73字节PNG冻结SHA/ETag、私有排除、reference null、401、过滤与重复读取全部通过；86张非系统表前后count/digest完全一致。独立初审P0/P1 NONE；127父DB、31unit、typecheck/lint/build及六audit通过。21:00:58Z核owner释放锁，隔离app/PG/S3已停且卷保留，原四服务healthy/current-release哈希未变。PR1600待准确最终head CI及合并等待窗；Start挂载/旧入口退出未完成。

- **YUK-1376（1358 W1 /mistakes）**：YUK1375已随PR1597合入36f719675，exact CI与独立review通过；本线程从最新main承接错题页非UI领域/API消费者迁移，保留视觉与现有行为；不改全局路由/manifest/package/lock或1352组合根，挂载交主线。1359退出清单继续由本线程维护。1352/1355/1356唯一集成与writer归主线57961995，不写其三树。

- **YUK-1365**：PR1593/1594已分别合入df08399ff/6e54da8df。主线恢复即时SSE listener接线；其发布负责人负责新镜像与真实流式验收，本线程不接管。1367另线负责正式练习出版/评分准入与paper深链。

- **YUK-1360 / PR1584**：已合入main26f101581，保留依赖升级与Mem0修补；本分支集成后冻结安装、309 DB/74 unit/typecheck/lint/build通过，等待新CI。源码合入不是部署授权或运行验收；pg-boss schema44/BAM、真实API/SPA及恢复义务见[依赖证据](docs/planning/2026-10-07-yuk1360-dependency-integration-evidence.md)。
- **YUK-1359**：首轮[旧路径退出调查](docs/planning/2026-10-07-yuk1359-exit-inventory.md)已完成源码抽查，未删除代码；主线负责后续集成和逐族切换。

- **YUK-1338 / YUK-1351 P0 gate**：PR #1590 已合入主线 42987dfd7，本分支同步集成。测试容器中验证 Pi + DBOS 状态版本、过期拒绝、四个进程终止边界、响应复用与单次业务效果；不等于整个迁移或真实 provider 重复付费问题已解决。证据见[gate 记录](docs/planning/2026-10-07-yuk1338-pi-dbos-gate.md)。

- **YUK-1356 业务操作迁移**：接口与消费者调查已交付[实施输入](docs/planning/2026-10-07-yuk1356-operation-seams.md)。主线57961995已接手独立树唯一实施writer，与1352/1355协调；本线程不重复实施。Pi可信作答来源、队列诊断投影与coverage语义必须保留，三入口统一尚未验收。

- **YUK-1362 / 当前部署用途**：仅供 Agent 开发测试，禁止再次清库或恢复私人数据。14:30Z实读 current-release 为1365发布 `6e54da8df` / image `fd8c046b97fe`，锁不存在；即时SSE已有1365证据，正文/取消验收仍受provider限额阻碍，1366负责现存DLQ。本线程未操作服务。此处是带时间的观察，后续发布仍须重新核验并原子取锁；日用须owner明确要求。
- **历史 YUK-1341 产品 AI 发布**：PR #1585 已通过 exact-head CI、独立初审和等待窗并合并。app/worker 都固定 `opencode-go/mimo-v2.6-pro`；54聊天任务和 Mem0 接线已落地。生产两轮 Copilot 成功，原会话及 Pi cursor 连续、刷新回放一致；后台 MemoryBrief 也已实际成功。未宣称所有任务质量或评分切片均获准入。
- **历史 YUK-1340 会话入口发布**：PR #1583 满足 exact-head CI、审查和等待窗后合并。准确 ARM64 镜像完成副本迁移、旧镜像读取兼容、停写备份恢复及生产页面验收。默认续接、历史只读、新建、重开、刷新保持会话均通过；没有发送 AI 消息。YUK-1343 两条 P2 仍延期。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习与数字工具，由 agent 在持续委托下负责实现和验证，不是已实现清单。
- **模型范围**：产品生成式/多模态 AI 为 MiMo2.6Pro；开发按 AGENTS 常规选模。专用 embedding、typed Jev 和 OCR 协议保留。现有评分准入与确定性功能不降级。

## NEXT

- **YUK-1364 已收口**：PR1591合入5aa2a9e98并发布准确853/image9b76至Agent TEST；102表/97文件/Mem0恢复、真实HTTP与队列核验通过，17:33:31Z释放锁。源码与运行证据详见[1364记录](docs/planning/2026-10-07-yuk1364-probe-issuance.md)。

- 先落实 YUK-1346 的可信单次记忆/派生用途策略，再沿“椭圆难题 → 记录过程与帮助程度 → 区分暂时理解和独立迁移 → 后续验证安排”的真实学习路径推进。短回答成功不等于可靠评估已经兑现。
- YUK-1042：原队列已随 owner 明确授权的 YUK-1362 清库退出运行环境，完整历史保存在离线备份；不得自动重放或把删除历史当作修复重试安全缺陷。
- **TS 迁移 + UI 重写（epic YUK-1351）2026-10-07 owner 指示开工**：[准备计划](docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md) 原“每条路由同时交付新 UI”要求已被 owner 后续指令覆盖：先完成非 UI 迁移，保留现有页面，UI 重写暂缓。首批并行：**YUK-1338**（Pi + DBOS 状态版本/过期拒绝/重启恢复竖切，第一道 gate，不过 gate 不动生产）与 **YUK-1353**（视觉方向 loft）。UI 票（YUK-1353/1354/1357 及 P6 UI 子票）只交 Claude Opus 5.5；非 UI 开发按 AGENTS 常规选择。ADR 以 main 的 0066 为准。
- **早期单收口（2026-10-07）**：YUK-100..500 的 20 张已在 Linear 逐张裁定——147/213/295/310/406/443/464 转 Todo，369 Canceled（被 1038 取代），其余设触发条件与 10-21 / 11-07 复查截止，到期未触发即取消；406 验收裁定连带 405/418/419。

## PARKED


- **YUK-1360 父线程发布验收义务**：真实 startup 返回 schema44 时仍有7项 BAM index 工作 pending；不能把 start/health/Drizzle smoke 当作 background migration 完成。本 lane 验证 disposable 完成与 index validity；生产需父线程在既有发布流程核验。旧12.26.3默认启动仅证明单个 synthetic queue 操作，`migrate:false`拒绝44；没有执行或批准 queue downgrade。归入既有 YUK-1360/YUK-1329 验收，不在此 lane 新建 Linear。
- YUK-1346：单次“不写入记忆”的可信策略尚未实现，High/Backlog，选为下一条产品线；两条原假设验收摘要保留，不冒称已修。
- YUK-1343：失败创建提前标为显式来源、50条历史截断隐藏可续接会话均未修；已成组登记，不阻塞此次已裁决发布。

- YUK-1342：付费探针开关、不可覆盖封存及 OpenAI4 node-fetch 绕过 global-fetch 观测。副本记忆功能通过，但整体探针仍 FALSE；SDK wire/count/cost 不完整，不重复付费刷绿。
- YUK-1345：provider-only 校准默认值及旧 vision lane 同源归因，已裁决非阻塞；不把统一模型称为异源证据。
- YUK-1344：Tailscale 本机 HTTPS/鉴权和既有独立 peer 已验证，离家实体设备验证尚缺。
- YUK-1329：通用发布与回退演练仍未完成。旧备份 helper 的 auto-purge 文案/清单不适用当前保留策略；此前 MiMo 发布的 R2 时序补证保留。本次入口发布全部最终备份在停写后，101表计数恢复一致、63附件完整。
- YUK-1235：镜像外部 MCP/sharp 版本与 lock 漂移已有票；本轮无已证实可达 P0/P1，不扩张成依赖整治。
- YUK-1325 / PR #1580：保留 `1be38edbc`、`1af72b427`、`3940d61f9`，正常合入 main `8841ce68a` 为 `e484efa60`；359 scoped tests、21 audits、typecheck/lint/build 与 lint ratchet 通过，无 high/critical 依赖告警。开发 transcript 与产品 MiMo/自主交付指导同时保留。writer 已释放，父线程负责最终 SDK/SQL/browser 回放、push、exact-head CI、review replies、Linear 与发布；P2 typed tracing 留 YUK-1339，不启动第三审。详情见 [Laminar 记录](docs/planning/2026-10-06-yuk1325-laminar.md)。旧完成线程越界写入风险仍由父线程独占 watch 约束，平台跟进待去重登记。 最新 main 的前缀 credential P1 修复及73tests记录一并保留；PR父线程仍负责后续验收，此lane无新review。

## BLOCKED-ON

- YUK-1360新source checks不构成最终head CI/review或runtime acceptance。无新增actionable follow-up；四个peer warnings继承两parent，runtime/BAM/rollback限制仍属1360/1329。Linear capture归父线程。主runtime仅Agent TEST ONLY；切日用需owner后续明确要求。
- 无需 owner 追加日常授权。旧 Xiaomi402 不再阻塞新 Copilot；历史失败没有删除。
- 默认会话入口已在生产修复；完整学习状态评估和自适应安排仍需逐条行为验收，不能以此次日用修复冒称产品完成。
- 旧0f81整镜像读取新迁移副本兼容已验证；回退需刷新浏览器且恢复旧入口缺陷。数据库恢复仍须保护备份后新写入，不可自动覆盖。历史发布指针与锁记录不表示当前runtime状态。
- 每小时 T3 任务仍绑定原线程；需要 Mac/T3 运行。远程访问需要同一 tailnet、Mac 开机且用户会话内 daemon 在运行。
