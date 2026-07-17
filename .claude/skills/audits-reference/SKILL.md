---
name: audits-reference
description: Full mechanics of this repo's pnpm audit:* scripts and their allowlist/CI-gate wiring. Use when adding a new table/field, route contract, question write/read site, subject profile, learner-facing copy, feature flag, projection reducer, judge prompt, or knowledge_edge relation_type — or when an audit:* script fails.
---

# Audits reference

`pnpm audit:schema` 扫描 `src/db/schema.ts` 所有业务字段，验证每个都有 INSERT 或 UPDATE write path。例外字段须在 `scripts/audit-schema-allowlist.json` 显式声明 `reason` + `resolves_when`，其中 `resolves_when` 必须是 `{ "kind": "pr" | "phase" | "manual", "ref": string, "expected_by": "YYYY-MM-DD" }`。`kind: "pr"` 的 `ref` 写 GitHub PR 号或 `#N`，若本地 git history 已包含该 PR 会 fail；`kind: "phase"` 的 `ref` 要能匹配 `docs/superpowers/status.md` 的已 ship 行；`kind: "manual"` 只用于无法机器判定的历史解除条件，仍受 `expected_by` 到期约束。引入新表 / 字段时，要么实现 write path，要么加入 allowlist 并标注可检查的解除条件。详见 `docs/design/2026-05-15-data-assumptions.md`。

`pnpm audit:profile` 调用 `scripts/audit-profile.ts`，遍历 `subjectProfiles` 并复用 `validateProfile()` 检查 `SubjectProfileSchema`、`causeCategories` 唯一性、`judgeCapabilities` 是否已在默认 capability registry 注册，以及 registry-backed preferred route 是否已声明。新增或修改 subject profile 后必须先跑 `pnpm audit:profile`；坏 profile 也会在 `SubjectRegistry.register()` 启动期直接抛错。

`pnpm audit:draft-status`（YUK-350）调用 `scripts/audit-draft-status.ts`，扫所有 `.insert(question).values({ ... })` 站点（brace-balanced 抽对象块，跳字符串/模板/注释，word-boundary 排除 `question_block`/`question_part`），要求每个站点要么显式携带 `draft_status` key，要么在 `scripts/audit-draft-status-allowlist.json` 声明 `reason` + `resolves_when{kind,ref,expected_by}`。`question.draft_status` 是 NULL≡active 的三态字段——漏 set 的新 question 会被 review 池当 active 收，容器内专用题（embedded check / teaching check）会静默漏进通用练习池。NULL≡active 是合法语义的 writer（auto-enroll / import / 错题 / 卷题）放 allowlist；allowlisted-AND-explicit 文件静默通过（不 hard-fail）。新增 question INSERT 时要么显式 set draft_status，要么加 allowlist 并标注解除条件。它已接入 `pnpm test` 链，所以容器题漏进池的失效模式由自动 gate 强制。执行强度校准（2026-07-17）：`audit:schema`、`audit:dependencies`、`audit:partition` 由 `.github/workflows/ci-gate.yml` 作为独立步骤在每个非-docs PR 远端硬 gate；`pnpm test`（= `audit:api-contracts` + `audit:profile` + `audit:learner-copy` + `audit:no-learning-styles` + `audit:draft-status` + `audit:draft-status-reads --strict` + unit/db/migration）同样在 CI 运行。真实差异只在本地：前三个需手跑或依赖 CI，其余六个随 `pnpm test` 执行。详见 `docs/design/2026-05-15-data-assumptions.md`。

`pnpm audit:api-contracts`（YUK-647）组合并验证 capability manifests，要求每条 API route 要么声明 contract、要么在 `scripts/api-route-contract-legacy.json` 显式登记，并验证生成的 OpenAPI 文档。它是 `pnpm test` 的第一步；新增或迁移 route 时应同步更新 manifest contract 或 legacy allowlist。

`pnpm audit:learner-copy`（YUK-506）只扫描 `LEARNER_COPY_FILES` 列出的学习者可见 surface，阻止 HTTP/SSE、内部 task/session 名、FSRS/PFA/IRT、存储/worker 等实现术语进入产品文案；例外放 `scripts/audit-learner-copy-allowlist.json`，且精确到 file/label/valueIncludes/reason。新增学习者页面时要把文件显式加入扫描面。`pnpm audit:no-learning-styles` 扫描 `src/` 与 `server/` 的生产 TS/TSX，禁止 VAK/VARK、视觉/听觉/动觉型学习者和 learning-style 个性化表述；注释与测试不计。两者均在 `pnpm test` 中硬 gate。

`pnpm audit:draft-status-reads`（YUK-569）是 INSERT 审计的读侧同伴，要求 NULL≡active 的 pool 可见性查询走 `src/db/predicates.ts` 的 `notDraftPredicate` / `isPoolVisible`，并对新 raw-SQL shape fail closed。默认报告；`pnpm test` 固定用 `--strict`，因此非 allowlist 的手写 predicate、未知 SQL shape、allowlist hygiene 或 helper sentinel 漂移都会阻断。

`pnpm audit:relations`（YUK-357 / RT4）调用 `scripts/audit-relations.ts`，做 **KG 死边反向审计**（gap-analysis 决策 7 / gate doc §1.7 7c，源自 GPT §10.1「只保留能影响诊断/推荐/复习的关系」）。对每个核心 `knowledge_edge.relation_type`（prerequisite / related_to / contrasts_with / applied_in / derived_from）反查下游消费路径，按三层分级——`creation-validation`（提议时校验，不算下游学习消费）/ `generic-read`（copilot 一把灌所有 type，最弱信号）/ `specialized`（诊断/推荐/复习按具体 type 驱动行为）。**「死边」= 某 type 零 specialized 消费**（图在转但不影响学习）。消费矩阵是手维护的声明式 `CONSUMER_REGISTRY`，每条带 `file:marker` 证据；脚本对每条做**源码反查**，marker 不再命中即报 STALE（registry↔代码漂移）。默认 report-only（exit 0），`--strict` 才非零 exit（gate doc §1.7 标「→ Linear follow-up」非硬 gate；升级为 CI gate 是 owner 决策）。当前实测唯一死边 = `applied_in`（hub-mesh 显式排除、topology-gate 仅 prerequisite、paths 反向邻接仅 related_to/contrasts_with）。新增「按 relation_type 分支」的消费路径时须在 registry 补一条。

其余专项审计：

- `audit:dependencies`：`pnpm audit --prod --audit-level=high`，CI standalone hard gate。
- `audit:fold-writes`：fold-owned projection 表写者 registry ↔ 源码反查；默认 report-only，`--strict` 对未授权写点/陈旧 registry fail。
- `audit:flags`：`*_ENABLED` 代码 ↔ `audit-flags-ledger.json` 对账；默认 report-only，`--strict` 对漏登记/陈旧/坏 ledger fail，字面量差异只报告。
- `audit:projection`：连接目标 DB，把全部 projection 由 event 重放并与 live row deep-diff；非 allowlist drift 直接 fail，只应对 prod clone / 明确目标库运行。
- `audit:golden --kind=<kind>`：用当前 reducer/gather 重放保留的 imperative golden；适用于已翻 ON entity 的 reducer/gather 变更，drift 直接 fail。
- `audit:judge-golden`：冻结 raw LLM 输出到 `JudgeResultV2` 的离线规范化回放；默认 report-only，`--strict` fail，不覆盖 prompt/model 变化。
- `audit:judge-prompts`：judge task × subject profile 的渲染 prompt snapshot；`--strict` 对 missing/content/stale drift fail，意图变更用 `--write` 后提交 snapshot diff。
- `audit:calibration` / `audit:mastery-provenance`：分别做 A1 SRT 前向校准诊断与 mastery provenance 消费纪律反查；均为 read-only，后者支持 `--strict`。

`/audit-drift` skill（`.claude/skills/audit-drift/SKILL.md`）扫描 **ADR / planning-doc ↔ 代码实现**结构性漂移（不重审 schema）。交互模式写 `docs/audit/YYYY-MM-DD-drift.md`；定时模式不写仓库、不建分支/PR，只在完成去重后创建或更新带 `drift` label 的 Linear issue。配套 `pnpm audit:schema` 形成 schema 层 + 决策层双 lint。
