---
name: audits-reference
description: Full mechanics of this repo's pnpm audit:* scripts and their allowlist/CI-gate wiring. Use when adding a new table/field, route contract, question write/read site, subject profile, learner-facing copy, feature flag, projection reducer, judge prompt, or knowledge_edge relation_type — or when an audit:* script fails.
---

# Audits reference

`pnpm audit:schema` 扫描 `src/db/schema.ts` 所有业务字段，验证每个都有 INSERT 或 UPDATE write path。无 write path 的字段（stub）必须在比较基（`--base` / `CAPABILITY_BASE_SHA` / `TEST_POLICY_BASE`，否则与 origin/main 的 merge-base）上同样是 stub 才放行——base 实测是唯一豁免，无台账文件；存量 stub 按 base grandfather，新增字段必须自带 write path 或删 schema 定义。详见 `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/design/2026-05-15-data-assumptions.md`。 生产证据排除 tests/fixtures/rehearsal（含命名的辅助文件）；Drizzle 对象按有界 AST 追踪真实构造、调用参数、返回值、数组与 spread，未知 wrapper/仅类型声明/重赋值容器不计字段。离线重建写入仍是源码写入证据，不等同于当前在线 producer。

`pnpm audit:profile` 调用 `scripts/audit-profile.ts`，遍历 `subjectProfiles` 并复用 `validateProfile()` 检查 `SubjectProfileSchema`、`causeCategories` 唯一性、`judgeCapabilities` 是否已在默认 capability registry 注册，以及 registry-backed preferred route 是否已声明。新增或修改 subject profile 后必须先跑 `pnpm audit:profile`；坏 profile 也会在 `SubjectRegistry.register()` 启动期直接抛错。

`pnpm audit:draft-status`（YUK-350）调用 `scripts/audit-draft-status.ts`，扫所有 `.insert(question).values({ ... })` 站点（brace-balanced 抽对象块，跳字符串/模板/注释，word-boundary 排除 `question_block`/`question_part`），要求每个站点显式携带 `draft_status` key；缺 key 站点按文件计数与比较基线（merge-base，rename 跟随 `git diff -M`）对账，存量可留可减、超量即 fail——没有 allowlist，存量豁免的唯一来源是基线实测。`question.draft_status` 是 NULL≡active 的三态字段——漏 set 的新 question 会被 review 池当 active 收，容器内专用题（embedded check / teaching check）会静默漏进通用练习池。新增 question INSERT 必须显式 set draft_status。它已接入 `pnpm test` 链，所以容器题漏进池的失效模式由自动 gate 强制。执行强度校准（2026-07-17）：`audit:schema`、`audit:dependencies`、`audit:partition` 由 `.github/workflows/ci-gate.yml` 作为独立步骤在每个非-docs PR 远端硬 gate；`pnpm test`（= `audit:api-contracts` + `audit:profile` + `audit:learner-copy` + `audit:no-learning-styles` + `audit:draft-status` + unit/db/migration）同样在 CI 运行。真实差异只在本地：前三个需手跑或依赖 CI，其余六个随 `pnpm test` 执行。详见 `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/design/2026-05-15-data-assumptions.md`。

`pnpm audit:api-contracts`（YUK-647）组合并验证 capability manifests，要求每条 API route 声明 contract，并验证生成的 OpenAPI 文档。它是 `pnpm test` 的第一步；新增或迁移 route 时必须同步声明 contract（YUK-1867 起无 legacy 豁免台账）。

`pnpm audit:learner-copy`（YUK-506）只扫描 `LEARNER_COPY_FILES` 列出的学习者可见 surface，阻止 HTTP/SSE、内部 task/session 名、FSRS/PFA/IRT、存储/worker 等实现术语进入产品文案；新增学习者页面时要把文件显式加入扫描面。`pnpm audit:no-learning-styles` 扫描 `src/` 与 `server/` 的生产 TS/TSX，禁止 VAK/VARK、视觉/听觉/动觉型学习者和 learning-style 个性化表述；注释与测试不计。两者均在 `pnpm test` 中硬 gate。

读侧和 INSERT 侧在同一次 `pnpm audit:draft-status` 里失败即退出。池可见性查询必须走 `src/db/predicates.ts` 的 `notDraftPredicate` / `isPoolVisible`；手写 family-1 predicate、未知 SQL shape 或 helper sentinel 漂移都会阻断（helper sentinel 永不豁免）。读侧 hit/unknown 同样按文件计数对比较基线，超量即 fail；写读两侧预算独立。

`pnpm audit:relations`（YUK-357 / RT4）调用 `scripts/audit-relations.ts`，做 **KG 死边反向审计**（gap-analysis 决策 7 / gate doc §1.7 7c，源自 GPT §10.1「只保留能影响诊断/推荐/复习的关系」）。对每个核心 `knowledge_edge.relation_type`（prerequisite / related_to / contrasts_with / applied_in / derived_from）反查下游消费路径，按三层分级——`creation-validation`（提议时校验，不算下游学习消费）/ `generic-read`（copilot 一把灌所有 type，最弱信号）/ `specialized`（诊断/推荐/复习按具体 type 驱动行为）。**「死边」= 某 type 零 specialized 消费**（图在转但不影响学习）。消费矩阵是手维护的声明式 `CONSUMER_REGISTRY`，每条带 `file:marker` 证据；脚本对每条做**源码反查**，marker 不再命中即报 STALE（registry↔代码漂移）。默认 report-only（exit 0），`--strict` 才非零 exit（policy audit lane 与 `pnpm test` 前缀跑默认命令，死边与 STALE 不失败；`--strict` 仍不进 CI）。当前实测死边 = `applied_in`（hub-mesh 显式排除、topology-gate 仅 prerequisite、paths 反向邻接仅 related_to/contrasts_with）与 misconception `observed_in`。新增「按 relation_type 分支」的消费路径时须在 registry 补一条。

`pnpm audit:architecture-deepening`（YUK-886 / F4.1）调用 `scripts/audit-architecture-deepening.ts`，是合并了 YUK-885 architecture-ownership 审计的**定量架构审计**：每个 owned TaskSpec 单 owner、不锁总数（ProfileCriticTask 属 ingestion 且 `compile-profile --critic` 在册）/ 0 中央语义定义、每个注册 DomainTool 单 owner + 输入输出 schema + manifest/registry/allowlist 对账 + MCP 输出校验 / 0 中央 concrete 工具、每个域 pg-boss 队列 manifest-owned 且注册元数据对账 / 0 中央语义注册、每个受支持 proposal kind 单 owner 且 accept/dismiss/retract 声明齐全 / 0 中央 kind-switch、中央 events 仅 transport/envelope、provider attempt census 全分类（无 unknown-as-zero）、依赖总量严格低于 531/70/62 且 deep/隐藏写/未编目回环全零、原始 SCC 完全由 `scripts/capability-public-read-cycles.ts` 有界目录解释。它接入 `pnpm test` 链与 CI Audits 步骤。相对 base 新增的纯转出站点一律失败，唯一例外是 `*/public.ts` 内 `symbol`/`targetSymbol` 均非 `*` 的具名 `module`/`site` 转出（公开入口，非壳）；无人工分类台账，比较键不含 detail/scanner 指纹。`audit:capability-boundaries` 的 base 实测 ratchet 与本审计的 531/70/62 天花板是两道独立 gate，不得为过其一而放宽另一。两道 gate 的 capability→server 口径不同：`audit:capability-boundaries` 的只降 ratchet 不含目标为 `src/server/ai`、`src/server/boss` 的平台依赖边（Owner 2026-11-03「ai/boss 属于平台依赖，不算债」，报告里单列「平台依赖（不计入 ratchet）」）；本审计的 531 天花板按含平台边的全量比较。

其余专项审计：

- `audit:provider-lanes`：lane 接线，并包含 attempt-truth（wrapper、legacy cost、zero-cost）。`pnpm test` 前缀与 CI policy audit lane 都跑它。
- `audit:dependencies`：`pnpm audit --prod --audit-level=high`，CI standalone hard gate。
- `audit:fold-writes`：fold-owned projection 表写者 registry ↔ 源码反查；默认 report-only，`--strict` 对未授权写点/陈旧 registry fail。
- `audit:flags`：唯一登记处是 `src/core/config/registry.ts` 的 `CONFIG_REGISTRY`（boolean env 开关 + operator enum/CSV/JSON 控制项）；11 个编译期 const 由领域源码自己的 `const NAME = true|false` 登记；reader 从 `getConfig`/`getConfigFlag`/`getConfigMany` 调用点推导。默认 report-only，`--strict` 对未登记 flag、定义与 `envParse` 不符、无 reader、const 重复、以及相对 base 的 env 名/envMode/字面量域/枚举值漂移 fail；默认值变化与 base/head 增删、reader 变化只报告；base 取不到即失败。
- `audit:golden --kind=<kind>`：用当前 reducer/gather 重放保留的 imperative golden；适用于已翻 ON entity 的 reducer/gather 变更，drift 直接 fail。
- `audit:mastery-provenance`（YUK-559 / S2）：mastery provenance 消费纪律反查；unguarded 的 `.mastery`/`.theta_hat` 读按比较基线豁免——base 已 unguarded 的文件标 `base`，基线无记录的新 unguarded 消费标 FLAGGED；tracked 文件失踪仍记 MISSING。默认 report-only（exit 0），`--strict` 才非零 exit（policy audit lane 与 `pnpm test` 前缀跑默认命令；`--strict` 仍不进 CI）。升 hard-gate 绑「任一借用 flag 翻转」前置（spec §7 open question 4）。

连库报告不在 `audit:` 里，也不是 CI gate、不进 `pnpm test`：

- `ops:projection`（`scripts/ops-projection.ts`，allowlist `scripts/ops-projection-allowlist.json`）：连接目标 DB，把全部 projection 由 event 重放并与 live row deep-diff；非 allowlist drift 直接 fail。需要 `DATABASE_URL`，只应对 prod clone / 明确目标库运行。
- `ops:calibration`（`scripts/ops-calibration.ts`）：A1 SRT 前向校准诊断，read-only / report-only。需要 `DATABASE_URL`。
- `ops:threshold-calibration`（`scripts/ops-threshold-calibration.ts`）：嵌入距离阈值分布报告，read-only。优先 `AUDIT_READ_DATABASE_URL`，否则 `DATABASE_URL`。
- `audit:advisory-locks`：生产 `.ts`/`.tsx`（排除测试与注释）里裸 `pg_advisory*` / `pg_try_advisory*` 的计数棘轮。`src/kernel/locks/` 与 `src/db/learning-state-lock.ts`、`src/db/session-advisory-lock.ts`、`src/server/ai/provider-attempt-lock.ts`、`src/capabilities/agency/server/conjecture/probe-lock.ts`、`src/capabilities/agency/server/intervention/intervention-lock.ts` 是批准的注册表/helper，可以持有 SQL。无台账：其余文件的调用次数与比较基（`TEST_POLICY_BASE`/`CAPABILITY_BASE_SHA`/`--base`，否则与 `origin/main` 分叉点）实测数比较——base 上已有的站点可保持或缩减，新站点或计数增加即失败；rename 经 `git diff -M` 跟随。不校验 81 族、不证明锁顺序。

`pnpm audit:review-action-readers`：生产 `.ts`/`.tsx`（排除测试、注释和字符串）里 `eq(event.action, 'review')` 的计数棘轮。比较基同上：已有站点可保持或缩减，新站点或计数增加即失败。接入 `pnpm test` 前缀与 CI Audits 步骤。

`/audit-drift` skill（`.claude/skills/audit-drift/SKILL.md`）扫描 **ADR / planning-doc ↔ 代码实现**结构性漂移（不重审 schema）。交互模式写 `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/audit/YYYY-MM-DD-drift.md`；定时模式不写仓库、不建分支/PR，只在完成去重后创建或更新带 `drift` label 的 Linear issue。配套 `pnpm audit:schema` 形成 schema 层 + 决策层双 lint。
