# PLAN — 活看板

> Linear 是权威 tracker。2026-10-08：1356 PR1605准确4cccb1a62 CI全绿、R2 NONE，父真实MiMo/Pi提交原件与单次效果验收完成（费用估算$0.002818771）；HTTP重放201断言误写200已以源码/19类快照裁决，无重付。证据封存后等新CI合并，未部署。Today/Inbox源码已交回，独立R1进行；1358/1359继续。

## NOW

- **YUK-1359 / W2消费者清单**：本线程独占退出证据；从main6150f01a9调查/record、/events/$id、/drafts和入门流程的读取、写入、恢复及共享子树。六页只读调查及父抽查已完成，见[W2清单](docs/planning/2026-10-08-yuk1359-w2-consumers.md)；新入口和运行验收未完成，Start/1356归主线。

- **YUK-1378 / 领域slice已完成**：PR1604合入6150f01a9；准确head463aadec与合并tree一致，CI37765137606全绿，独立R1/R2 NONE、threads0。8unit/父实际11DB/static/build通过；public导出loadTodayCost与TodayCost，HTTP已复用，Start挂载交主线。未部署。[证据](docs/planning/2026-10-08-yuk1378-today-cost-read.md)。

- **YUK-1355 / PR1595**：默认 pg-boss，仅 prune_job_events 可切 DBOS；60s cached-cron receipt fence、unknown rollback hold、单 recovery owner 均保留。新 main 的业务变更原样合入，Node24.19 212 unit、typecheck/lint/ratchet/build 与8 static audits通过；源/fixture字节保持，新增bundle的DB验收交父。历史4 cron/recovery、28 worker DB、77 unit、26 migration 只代表旧源/旧bundle。R1/R2 NONE适用于48ead，预算已用，不新审。



- **YUK-1377 / Today 读取迁移**：PR1603已合入 `90f499126`；准确head53a70bf4a的CI37760493515全绿、独立review NONE，candidate/merge tree一致。summary公共读取与queryReviewDue注入DB已8DB、整合后42unit/typecheck/lint/build验证。1377/1358保持In Progress，主线继续Start鉴权/epoch/消费者及实际入口验收；不等于Today整页完成。[证据](docs/planning/2026-10-08-yuk1377-today-domain-reads.md)。

- **YUK-1352 Start /mistakes**：唯一1352 writer已接好 authenticated server function、旧页面注入及共享原shell；保留1364/1365/1375/1376 main源码，PR1600合入main后正常merge保留7631的public materials源码。98 scoped tests、typecheck/lint/build与边界audit通过；准确3d6273a14隔离RPC/浏览器/图片与失败重试已验收；全导航仅既有practice初始化增1行，后续错题读取86表无变化。[交付](docs/planning/2026-10-07-yuk1352-start-frontdoor.md)。

- **YUK-1376**：PR1600已于2026-10-07 21:18:58Z合入 `7100dfae4`，合并tree `743ee4d80617dc9b34c7533d724e052af5fd50c4` 与准确head `c40a18621` 一致；CI Gate `37686417034` 成功，独立初审P0/P1 NONE，无未裁决review threads，完整17分钟窗满足。未部署。Start挂载任务归主线，实际新入口行为及旧SPA退出尚未完成。 [验收矩阵](docs/planning/2026-10-08-yuk1376-start-acceptance.md)。

- **YUK-1376 / Start候选验收**：候选 `3d6273a14` 实际Start RPC、鉴权、冻结内容、图片bytes/Lightbox、筛选、刷新和重试通过。完整导航因旧practice GET首次初始化新增1行，其他85表不变；之后错题读取阶段86表不变，不能把整段称DB不变。158构建文件hash不变、源码树clean。21:39:38Z停自有服务并核owner释放锁，主四服务healthy/release未变；主线保留1352/PR1592集成发布。未关闭整个迁移或旧SPA退出。

- **YUK-1365**：PR1593/1594已分别合入df08399ff/6e54da8df。主线恢复即时SSE listener接线；其发布负责人负责新镜像与真实流式验收，本线程不接管。1367另线负责正式练习出版/评分准入与paper深链。

- **YUK-1360 / PR1584**：已合入main26f101581，保留依赖升级与Mem0修补；本分支集成后冻结安装、309 DB/74 unit/typecheck/lint/build通过，等待新CI。源码合入不是部署授权或运行验收；pg-boss schema44/BAM、真实API/SPA及恢复义务见[依赖证据](docs/planning/2026-10-07-yuk1360-dependency-integration-evidence.md)。
- **YUK-1359**：[W1消费者清单](docs/planning/2026-10-08-yuk1359-w1-consumers.md)已补全Today画像读取与学习意图提议，并抽查实际消费者。范围包括根跳转、Today和Inbox；这是实施输入，未完成Start切换或删除旧入口。主线负责集成，本线程维护[退出清单](docs/planning/2026-10-07-yuk1359-exit-inventory.md)。

- **YUK-1338 / YUK-1351 P0 gate**：PR #1590 已合入主线 42987dfd7，本分支同步集成。测试容器中验证 Pi + DBOS 状态版本、过期拒绝、四个进程终止边界、响应复用与单次业务效果；不等于整个迁移或真实 provider 重复付费问题已解决。证据见[gate 记录](docs/planning/2026-10-07-yuk1338-pi-dbos-gate.md)。

- **YUK-1356 业务操作迁移**：共享submitReviewAnswer已接HTTP/worker与真实Pi工具；鉴权chat保存明确授权的用户原件，工具只消费本turn/session绑定引用，新chat原件保守unknown assistance。父139+20 scoped DB通过，R2只读审查进行；真实模型/Start提交消费者、CI和最终交付仍待。[交接](docs/planning/2026-10-08-yuk1356-trusted-pi-handoff.md)。

- **YUK-1362 / 当前部署用途**：仅供 Agent 开发测试，禁止再次清库或恢复私人数据。14:30Z实读 current-release 为1365发布 `6e54da8df` / image `fd8c046b97fe`，锁不存在；即时SSE已有1365证据，正文/取消验收仍受provider限额阻碍，1366负责现存DLQ。本线程未操作服务。此处是带时间的观察，后续发布仍须重新核验并原子取锁；日用须owner明确要求。
- **历史 YUK-1341 产品 AI 发布**：PR #1585 已通过 exact-head CI、独立初审和等待窗并合并。app/worker 都固定 `opencode-go/mimo-v2.6-pro`；54聊天任务和 Mem0 接线已落地。生产两轮 Copilot 成功，原会话及 Pi cursor 连续、刷新回放一致；后台 MemoryBrief 也已实际成功。未宣称所有任务质量或评分切片均获准入。
- **历史 YUK-1340 会话入口发布**：PR #1583 满足 exact-head CI、审查和等待窗后合并。准确 ARM64 镜像完成副本迁移、旧镜像读取兼容、停写备份恢复及生产页面验收。默认续接、历史只读、新建、重开、刷新保持会话均通过；没有发送 AI 消息。YUK-1343 两条 P2 仍延期。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习与数字工具，由 agent 在持续委托下负责实现和验证，不是已实现清单。
- **模型范围**：产品生成式/多模态 AI 为 MiMo2.6Pro；开发按 AGENTS 常规选模。专用 embedding、typed Jev 和 OCR 协议保留。现有评分准入与确定性功能不降级。

## NEXT

- YUK-1356 完成独立审查/P0-P1修复、exact-head CI与真实Pi输出验收；沿1358继续Today/Inbox Start消费者，不将当前原件提交切片当全部迁移完成。

- **YUK-1352 / PR1592**：已合入main eae963377，CI37758570995与合并tree一致；隔离错题入口已验收，未部署。剩余路由与canonical boot继续。

- **YUK-1352主线接续**：PR1592已合入eae963377；Today/Inbox Start消费者、canonical启动与旧SPA退出仍由主线负责，不能将既有/mistakes局部验收当作整站完成。

- **YUK-1364 已收口**：PR1591合入5aa2a9e98并发布准确853/image9b76至Agent TEST；102表/97文件/Mem0恢复、真实HTTP与队列核验通过，17:33:31Z释放锁。源码与运行证据详见[1364记录](docs/planning/2026-10-07-yuk1364-probe-issuance.md)。

- 先落实 YUK-1346 的可信单次记忆/派生用途策略，再沿“椭圆难题 → 记录过程与帮助程度 → 区分暂时理解和独立迁移 → 后续验证安排”的真实学习路径推进。短回答成功不等于可靠评估已经兑现。
- YUK-1042：原队列已随 owner 明确授权的 YUK-1362 清库退出运行环境，完整历史保存在离线备份；不得自动重放或把删除历史当作修复重试安全缺陷。
- **TS 迁移 + UI 重写（epic YUK-1351）2026-10-07 owner 指示开工**：[准备计划](docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md) 原“每条路由同时交付新 UI”要求已被 owner 后续指令覆盖：先完成非 UI 迁移，保留现有页面，UI 重写暂缓。首批并行：**YUK-1338**（Pi + DBOS 状态版本/过期拒绝/重启恢复竖切，第一道 gate，不过 gate 不动生产）与 **YUK-1353**（视觉方向 loft）。UI 票（YUK-1353/1354/1357 及 P6 UI 子票）只交 Claude Opus 5.5；非 UI 开发按 AGENTS 常规选择。ADR 以 main 的 0066 为准。
- **早期单收口（2026-10-07）**：YUK-100..500 的 20 张已在 Linear 逐张裁定——147/213/295/310/406/443/464 转 Todo，369 Canceled（被 1038 取代），其余设触发条件与 10-21 / 11-07 复查截止，到期未触发即取消；406 验收裁定连带 405/418/419。

## PARKED

- YUK-1355 P2 comment4208022050：cron权威目录仍将 prune 注册点写为 ../handlers.ts。最小范围为目录说明及一行注册点/phase ownership 文档；不需要新 scheduler/catalog 子系统。已报告父线程裁决，本轮未改该 P2。

- **YUK-1359临时挂载退出**：生产SPA的/mistakes改为document handoff，Vite-only dev暂留原HTTP consumer；全部路由及dev/build/镜像入口迁入Start且逐页验收后删除旧SPA回落与dev adapter。未宣称其他路由退役。


- **YUK-1360 父线程发布验收义务**：真实 startup 返回 schema44 时仍有7项 BAM index 工作 pending；不能把 start/health/Drizzle smoke 当作 background migration 完成。本 lane 验证 disposable 完成与 index validity；生产需父线程在既有发布流程核验。旧12.26.3默认启动仅证明单个 synthetic queue 操作，`migrate:false`拒绝44；没有执行或批准 queue downgrade。归入既有 YUK-1360/YUK-1329 验收，不在此 lane 新建 Linear。
- YUK-1346：源码已有单次派生用途策略，本轮保持其边界，不重开记忆修复；真实运行验收仍由其 owner 核验。
- YUK-1343：失败创建提前标为显式来源、50条历史截断隐藏可续接会话均未修；已成组登记，不阻塞此次已裁决发布。

- YUK-1342：付费探针开关、不可覆盖封存及 OpenAI4 node-fetch 绕过 global-fetch 观测。副本记忆功能通过，但整体探针仍 FALSE；SDK wire/count/cost 不完整，不重复付费刷绿。
- YUK-1345：provider-only 校准默认值及旧 vision lane 同源归因，已裁决非阻塞；不把统一模型称为异源证据。
- YUK-1344：Tailscale 本机 HTTPS/鉴权和既有独立 peer 已验证，离家实体设备验证尚缺。
- YUK-1329：通用发布与回退演练仍未完成。旧备份 helper 的 auto-purge 文案/清单不适用当前保留策略；此前 MiMo 发布的 R2 时序补证保留。本次入口发布全部最终备份在停写后，101表计数恢复一致、63附件完整。
- YUK-1235：镜像外部 MCP/sharp 版本与 lock 漂移已有票；本轮无已证实可达 P0/P1，不扩张成依赖整治。
- YUK-1325 / PR #1580：保留 `1be38edbc`、`1af72b427`、`3940d61f9`，正常合入 main `8841ce68a` 为 `e484efa60`；359 scoped tests、21 audits、typecheck/lint/build 与 lint ratchet 通过，无 high/critical 依赖告警。开发 transcript 与产品 MiMo/自主交付指导同时保留。writer 已释放，父线程负责最终 SDK/SQL/browser 回放、push、exact-head CI、review replies、Linear 与发布；P2 typed tracing 留 YUK-1339，不启动第三审。详情见 [Laminar 记录](docs/planning/2026-10-06-yuk1325-laminar.md)。旧完成线程越界写入风险仍由父线程独占 watch 约束，平台跟进待去重登记。 最新 main 的前缀 credential P1 修复及73tests记录一并保留；PR父线程仍负责后续验收，此lane无新review。

## BLOCKED-ON

- YUK-1355 PR1595已合入caeb959fd，tree与准确CI a9663e8一致；仅prune任务族迁移，其他DBOS任务族和最终测试部署仍待。

- YUK-1352隔离路由验收已通过；canonical boot/release/SSE及其他路由退出未验收；父线程拥有runtime lock、材料/R2证据、PR/Linear及发布权。本writer无新增领域follow-up，既有1359/1376退出义务保留。

- YUK-1360新source checks不构成最终head CI/review或runtime acceptance。无新增actionable follow-up；四个peer warnings继承两parent，runtime/BAM/rollback限制仍属1360/1329。Linear capture归父线程。主runtime仅Agent TEST ONLY；切日用需owner后续明确要求。
- 无需 owner 追加日常授权。旧 Xiaomi402 不再阻塞新 Copilot；历史失败没有删除。
- 默认会话入口已在生产修复；完整学习状态评估和自适应安排仍需逐条行为验收，不能以此次日用修复冒称产品完成。
- 旧0f81整镜像读取新迁移副本兼容已验证；回退需刷新浏览器且恢复旧入口缺陷。数据库恢复仍须保护备份后新写入，不可自动覆盖。历史发布指针与锁记录不表示当前runtime状态。
- 每小时 T3 任务仍绑定原线程；需要 Mac/T3 运行。远程访问需要同一 tailnet、Mac 开机且用户会话内 daemon 在运行。
