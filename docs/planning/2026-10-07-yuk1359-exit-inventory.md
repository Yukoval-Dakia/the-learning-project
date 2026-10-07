# YUK-1359 旧路径退出与文档一致性调查

状态：首轮调查及父级源码抽查完成；这是退出工作的输入，不是完整逐族迁移台账，未删除代码、未完成迁移。源码基线为 main `26f1015810cc3d902f6229b615d9630f05982eef`；通过 `git show` 读取，未切换或修改其他实施工作树。主线线程 57961995 负责整体集成；本线程负责只读消费者调查与此文档，1352/1355/1356 的实现归原 writer。

Owner 的后续指令是先完成整个非 UI 迁移，UI 暂缓，再完成 Linear 残留功能；见[当前优先级](2026-10-07-non-ui-migration-priority.md)。保留现有 UI 行为不等于永久保留旧 SPA 运行路径。最终删除必须以实际消费者切换和行为证据为条件。

## 准备计划中的冲突及精确修订建议

下表行号均指上述 main 基线的 `docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md`，不是动态 main。此处给出建议，不修改正在由其他线程使用的原计划。

| 原位置 | 问题 | 建议替换或处理 |
| --- | --- | --- |
| 3、8 行 | “未开始实施”和纯规划定位已不能说明当前进展 | 标明这是历史准备方案，当前实施以 Linear 和非 UI 优先级为准；不把整个原文伪装成当前运行状态 |
| 23–35 行，§2 | 强制每条新路由同时上线重写 UI，理由也以避免搬运旧 UI 为前提 | 将本节现行决定替换为：“先在 TanStack Start 保留现有页面与交互，迁移其路由、数据和业务接线；视觉重写另行恢复。每波独立验证业务与恢复行为。”旧决定移入历史决策记录 |
| 39 行 | 管理页面必须套新设计系统 | 暂缓设计系统变更；本轮管理页只迁移承载与数据接线，保持行为 |
| 45–48 行，§3 | SPA 回落和开关可能被误读为最终架构；删除被绑定“日用一周” | 明确回落仅为1352过渡方案；每条路径登记替代者、消费者、验证和删除任务。当前只在Agent测试环境验收，不能把owner尚未要求的日用部署当作迁移前置条件；保留必要的观察和恢复证据，不自动缩短已承诺门禁 |
| 49–51 行 | “生产”未区分重置后的测试用途，容易误导恢复旧私人库 | 当前目标明确为Agent测试环境。保留停写备份、隔离恢复验证、部署锁和恢复顺序；禁止再次清库或自动恢复私人数据 |
| 75–76、78–79 行，§5 | P2/P3/P4/P6仍把UI票列作迁移并行或退出依赖 | UI票保持延期；1356非UI退出条件独立于1357视觉交付；1358按路由/任务族列功能对等、恢复与旧入口删除证据，必要接线不视为视觉重写 |
| 80 行，P7 | “旧 primitives”直接进入删除目标，可能删除现有页面仍用的组件 | 将其改为“仅删除已无消费者的旧 primitives；仍服务保留页面的组件继续保留”。旧SPA启动/构建/回落与业务组件是否存活分别裁决 |
| 87–101 行，§6 | “不再空谈，用loft定稿”等措辞像当前实施指令 | 标记整节为后续UI恢复时的预备输入，本轮不执行、不作为非UI迁移阻塞；保留Opus5.5限制 |
| 110–114 行，§7 | API保留绑定旧UI下线，混淆外观重写与网络调用方迁移 | API退役以真实页面/工具/外部消费者已切换为条件，保留必要契约并同步Postman；1357视觉工作延期，不阻止1356业务操作统一 |
| 147–148 行，§11 | epic仍在NEXT，UI loft可立即并行 | 替换为实际owner分工：1352/1355/1356主线实施、1364本线程收口、1359本线程调查；UI暂缓。阶段完成需引用提交与验收，不能仅改状态措辞 |
| 156、160行，§12 | 一周后统一删旧代码、P7删globals.css可能绕过消费者检查 | 对每个旧入口定义退出证据；仍被保留UI消费的样式不因技术栈迁移直接删除。视觉债留到UI恢复，不把它当成旧运行路径保留的理由 |

ADR-0066 的业务边界仍适用：页面命令、Pi工具和后台任务共用业务操作（34–49行）；一个义务仅由一个持久执行机制恢复（65–69行）。其105–106行是决策当时的运行状态和交付边界，后续应新增实施状态链接，不把历史陈述直接用作今天的运行证明。

## 消费者退出清单

以下均为精确基线的现役路径。尚未证明存在可立即删除的整块模块；“legacy”命名和未在一次搜索中命中都不能证明无消费者。

| 路径/符号与基线证据 | 实际消费者和当前职责 | 替代与退出条件 | 所属任务 |
| --- | --- | --- | --- |
| `web/src/main.tsx:3–25`、`web/src/router.tsx`；`server/index.ts:66–74` | SPA挂载TokenGate、QueryClient、Router；生产按RW_STATIC_DIR提供web/dist并回落index.html | 现有页面逐一由Start承载，保留鉴权、草稿、深链与导航；全部消费者迁移和回退验收后删除旧挂载/静态回落，不能永久双路由 | 1352前门、1358路由、1359清理 |
| `package.json:118–122`、`Dockerfile:19,95`、`web/vite.config.ts` | rw:web构建、rw:api开发入口、镜像静态产物和RW_STATIC_DIR仍服务当前入口 | 同步切换build/dev/镜像COPY/运行入口及测试，不只删除web目录。生产容器与开发模式都需证明仅一个入口 | 1352、1359 |
| `server/app.ts:114–228`、capability manifests | Hono承担API token、epoch、manifest路由装配和404；practice仍注册legacy-review-sessions、legacy-practice、legacy-paper-detail | 先迁移实际调用方及共享业务操作；Hono是保留HTTP组合根还是迁到Start routes，须P7 ADR裁决，不能当作已决定删除 | 1352、1356、1358、1359 |
| `src/ui/lib/api`；CopilotDock.tsx:38、PfPaper.tsx:52，以及notes/onboarding API模块 | 现有页面真实依赖HTTP客户端，不是无用兼容层 | 按消费者迁移收缩；server function只替换网络入口，不复制业务规则。仍使用HTTP契约的消费者需要继续支持 | 1352、1358、1359 |
| `scripts/worker.ts`、`src/server/boss/start-worker.ts:108–122` | app开发模式与独立worker共用注册流程；先注册capability队列，再发verify启动恢复，顺序是活性契约 | DBOS接手所有义务后再删pg-boss启动/恢复路径；同一任务不可被双恢复。开发模式RW_WORKER也需迁移 | 1355、1359 |
| `src/server/boss/handlers.ts:178–224` | verify_dispatch_recover读取持久intent，只重投quiz_verify/source_verify；基础cron使用INFRA_HOUSEKEEPING_SCHEDULES | 保留intent、目标队列/工作流准备顺序和只恢复验证的边界；验收切换交错与真实cron，不能硬编码doubleSchedule=false作证 | 1355及对应业务族、1359 |
| `src/capabilities/practice/manifest.ts:961–974` | judge_pending_reconcile扫描已录作答但判词未落的义务，经限流入队judge_run | 新judge工作流唯一负责恢复后停用旧sweeper；已有pending、未知外部结果、重复回执、取消和版本冲突逐项裁决 | 1355、1356、1359 |
| `src/capabilities/copilot/manifest.ts:227–241` | copilot_run_reconcile按两分钟节奏修复持久outcome，并只处理队列证实的执行前丢失/过期歧义 | 迁移时保留bounded liveness与unknown判断；不能将旧队列查不到等同未执行而盲重试 | 1355、1358、1359 |
| `src/server/memory/memory-reconcile-handoff.ts:28` | memory_reconcile及其持久交接义务仍存活 | 保留确定job身份、outbox/domain恢复语义，接手唯一恢复责任后方可删除旧队列机制 | 1355、1358、1359 |
| `package.json:162`、`docker-compose.yml:81–84` | pg-boss仍是生产依赖；worker有30秒优雅排空要求 | 所有生产者、handler、cron、reconcile和诊断读面迁移后移除依赖；schema退役要有备份/恢复演练与义务排空，不因测试库曾重置而跳过源码和运行验证 | 1355、1359 |
| `src/server/ai/execution-adapter.ts:177–183`、`src/server/ai/runner.ts` | ExecutionAdapter仍创建PiAgentAdapter并被runner消费 | Pi是保留方向；只在旧消息形状全部消费者完成迁移且行为验证后收缩适配，不能按adapter文件名直接删 | 业务迁移责任方、1359最终核对 |

README中的注册任务数量只是基线文档陈述，本调查未执行全量注册器 census，不能据此证明全部任务族已覆盖。完整生产者/cron/DLQ/恢复台账继续由1355维护，本表突出不能在清理中丢失的职责。

### 未合入基线的候选路径

Linear1359已登记1352候选 `server/start/routes/$.ts`、`server/frontdoor.ts` 的 `buildLegacySpa`、`FrontdoorContext.legacySpa` 和双router清理归属。父核对 `git ls-tree -r 26f101581 server/`：该精确基线尚无这些文件。它们是候选实施的退出目标，不能据此把当前main描述成已运行Start；本轮未读取其活跃工作树。

### 证据边界与需纠正的历史叙述

只读子任务提供消费者线索；父直接核对SPA挂载、静态回落、build入口、worker注册顺序、verify恢复、judge/Copilot sweeper和Pi适配实例。已修正子任务中的 `web/router.tsx` 路径笔误，应为 `web/src/router.tsx`。子任务沿用旧ADR称Pi步骤恢复“未验证”，该说法过时：基线已含PR1590的隔离P0 gate；但P0不是所有真实业务族迁移和provider窗口验收，不能扩大结论。

本轮没有执行服务、测试、删除代码或依赖修改。全部可执行退出工作已归入现有1352/1355/1356/1358/1359；未发现需另开票的已证实新缺陷，不为清单条目重复建票。
