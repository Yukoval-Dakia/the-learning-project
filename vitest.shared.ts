import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const resolveConfig = {
  alias: { '@': path.resolve(__dirname, 'src') },
};

// YUK-279 — single source of truth for the JSX transform both vitest configs
// share. tsconfig has `jsx: "preserve"` (Next transforms JSX at build), so vitest
// must transform JSX itself via esbuild's automatic runtime; otherwise component
// tests crash with `React is not defined`. Both the unit and db configs import
// this so the transform can never drift between the two partitions.
// YUK-315 (2026-06-10) — vite 8 起 JS 转换引擎为 Rolldown/Oxc：`esbuild` 配置项在
// vitest 链路下不再生效（tsconfig jsx:preserve 的 JSX 无人转换 → .tsx 测试 parse
// 失败），等价物为 oxc.jsx（runtime automatic，同语义）。legacy 单 config
//（vitest.config.ts，pnpm test:legacy）如需 .tsx 同样换 oxc。
export const sharedOxc = {
  jsx: { runtime: 'automatic' },
} as const;

// DEPRECATED (YUK-315)：vite 7 时代的 esbuild 形态，仅留作历史参照；新 config 用 sharedOxc。
export const sharedEsbuild = {
  jsx: 'automatic',
} as const;

// YUK-279 — every `.test.ts` AND `.test.tsx` glob must appear here. allTestInclude
// is the *universe* of test files: the db config includes it directly, and the
// audit walker treats anything matching it as "in some partition". A `.test.tsx`
// file that matches NO entry here lands in NEITHER vitest config (db excludes
// fastTestInclude, but a file the db config never `include`d is simply never
// collected) and is invisible to the auditor → a silent green non-run. The `.tsx`
// globs below are deliberately as broad as the `.ts` ones so component tests can
// never fall through; fastTestInclude (the unit allowlist) still decides which of
// them run no-DB, and any `.tsx` not on that allowlist falls through to the db
// partition exactly like a `.test.ts` would.
export const allTestInclude = [
  '*.test.ts',
  '*.test.tsx',
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'tests/**/*.test.ts',
  'tests/**/*.test.tsx',
  'scripts/**/*.test.ts',
  'scripts/**/*.test.tsx',
  // M0 (YUK-313) — 新栈两棵树（Hono server / Vite SPA）进测试宇宙。
  'server/**/*.test.ts',
  'web/**/*.test.ts',
  'web/**/*.test.tsx',
];

export const fastTestInclude = [
  // ARCH-P1 (YUK-311) — 新 kernel/capabilities 树的约定式快分区：
  // *.unit.test.ts 按【命名约定】跑 no-DB 车道，零逐文件登记；*.db.test.ts
  // 落到 db 分区（匹配 allTestInclude 的 src/**/*.test.ts，又被下面这两个
  // glob 排除出 fast）。audit:partition 的 P0 检查照常生效：约定树里
  // *.unit.test.ts 若未 mock 就 import DB，审计直接报错。
  'src/kernel/**/*.unit.test.ts',
  'src/capabilities/**/*.unit.test.ts',
  // ADR-0033 D5 (YUK-203) — capability UI component tests are JSX, so they need
  // the .tsx extension; the *.unit.test.tsx naming runs them in the no-DB unit
  // car (renderToString, node env) exactly like a *.unit.test.ts. Same P0 guard
  // applies: a *.unit.test.tsx that imports DB unmocked fails audit:partition.
  'src/capabilities/**/*.unit.test.tsx',
  // M0 (YUK-313) — server/web 树同享命名约定分区。
  // M1 (YUK-314) — ingestion 19 条 allowlist 条目已随簇迁入 capabilities，由约定 glob 接管。
  'server/**/*.unit.test.ts',
  'web/**/*.unit.test.ts',
  'scripts/**/*.test.ts',
  // YUK-263 — pure (no-DB) unit for the globalThis pool-cache HMR guard in
  // src/db/client.ts. `postgres` is vi.mock'd and the only @/db/client import is
  // a dynamic `await import()`, so no live Postgres is touched → unit partition.
  'src/db/client.test.ts',
  // YUK-383 Phase 0 — pure (no-DB) unit for the pgvector customType codec in
  // src/db/vector.ts (string <-> number[] only; no Postgres touched) → unit partition.
  'src/db/vector.test.ts',
  // YUK-383 Phase 0 — domain embedder + entity->embed-text are pure no-DB units
  // (fetch is stubbed in embed.test.ts; embed-source.test.ts is string-join only).
  'src/server/ai/embed.test.ts',
  'src/server/ai/embed-source.test.ts',
  // YUK-274 — pure (no-DB) unit for the globalThis singleton-cache HMR guard in
  // src/server/boss/client.ts. `pg-boss` is vi.mock'd and the only ./client
  // import is a dynamic `await import()`, so no live Postgres is touched → unit
  // partition. The live-DB round-trip + SEND_IT race tests stay in the sibling
  // client.test.ts (db partition).
  'src/server/boss/client.globalthis.test.ts',
  'src/__tests__/**/*.test.ts',
  'src/ai/**/*.test.ts',
  'src/core/**/*.test.ts',
  'src/server/ai/judges/**/*.test.ts',
  // YUK-238 / YUK-240 — streamTask client-disconnect abort + stuck-run warn.
  // Pure no-DB unit: @anthropic-ai/claude-agent-sdk and @/server/ai/log are
  // vi.mock'd and `db` is an untouched stub, so no live Postgres is needed.
  // (The sibling runner.test.ts stays in the db partition because it drives the
  // real ai/log writers against a container.)
  'src/server/ai/stream-cancel.test.ts',
  // YUK-266 (C1) — streamTaskCollecting collecting-stream unit. Same justification
  // as stream-cancel: @anthropic-ai/claude-agent-sdk + @/server/ai/log are vi.mock'd
  // and `db` is an untouched stub, so no live Postgres is needed.
  'src/server/ai/runner.stream-collect.test.ts',
  // YUK-299 — runner outputFormat seam: zero-regression + structured_output
  // three-state read. Same justification as stream-cancel: @anthropic-ai/
  // claude-agent-sdk + @/server/ai/log are vi.mock'd and `db` is an untouched stub
  // → no live Postgres. src/server/ai/** has no unit glob, so this MUST be listed
  // or the db config's src/**/*.test.ts glob would sweep it into the container.
  'src/server/ai/runner.seam.test.ts',
  // YUK-299 — Zod→outputFormat adapter unit. Pure no-DB: imports only
  // ./output-format (→ zod-to-json-schema, pure JS) + @/core/schema/business (Zod).
  // Same enumeration requirement as above (no src/server/ai/** unit glob).
  'src/server/ai/output-format.test.ts',
  // YUK-359 — pure arithmetic cost fallback, no DB/SDK imports.
  'src/server/ai/pricing.test.ts',
  // YUK-365 — provider resolution (key vs oauth authMode, AI_PROVIDER_OVERRIDE
  // switch). Pure no-DB: imports only ./providers (→ @/ai/registry) + stubs env;
  // no @/db/client / postgres / SDK. src/server/ai/** has no unit glob, so this
  // MUST be listed or the db config's src/**/*.test.ts glob sweeps it into the
  // testcontainer partition (pricing.test.ts lesson).
  'src/server/ai/providers.test.ts',
  // B1-W1 (ADR-0035) — ItemPriorTask output parse barrier. Pure no-DB: imports
  // only ./item-prior (→ @/core/schema/item_prior, Zod) — no @/db/client /
  // postgres / drizzle / PgBoss. src/server/ai/** has no unit glob, so this MUST
  // be listed explicitly or the db config's src/**/*.test.ts glob sweeps it into
  // the testcontainer partition (pricing.test.ts lesson).
  'src/server/ai/item-prior.test.ts',
  // YUK-361 Phase 5 (Task 10) — 家族级 b_personalized 纯函数单测（shrinkage /
  // family_key / 客观路由分类 / 隐含难度残差 / effectiveFamilyB）。Pure no-DB: imports
  // 仅 ./personalized-difficulty（其 @/db/client import 是 type-only/erased，@/db/schema
  // 是 table objects 不连库，@/capabilities/knowledge/server/domain 也 type-only Db），
  // 不触 @/db/client 的 eager pool。门控 update 路径的 db 测在 personalized-difficulty.db.test.ts。
  // src/server/mastery/** 无 unit glob，故必须显式列出，否则 db config 的 src/**/*.test.ts
  // glob 会把它扫进 testcontainer 分区（item-prior.test.ts 同款）。
  'src/server/mastery/personalized-difficulty.test.ts',
  // YUK-361 Phase 6 (Task 11) — active-PPI 重标定纯函数单测（aipwMean §7 正确归一化 /
  // effectiveB read-compat / impliedBLabel IRT 反推 / PPI++ λ* power-tuning）。Pure no-DB:
  // imports 仅 ./recalibration（其 @/db/client 是 type-only/erased，@/db/schema 是 table
  // objects 不连库）+ ./personalized-difficulty（同款）。label hook + recalibrateQuestion
  // 的 db 测在 recalibration.db.test.ts。同 personalized-difficulty.test.ts 显式登记理由。
  'src/server/mastery/recalibration.test.ts',
  // YUK-372 L3 — family_key 解析 null-guard 纯逻辑单测（缺 primaryKnowledgeId/kind/source → null
  // 在任何 DB 调用前早返）。Pure no-DB: imports 仅 ./family-key（其 @/db/client / domain.ts 都是
  // type-only/erased，@/db/schema 是 table objects 不连库）。subject 派生/内存 walk 的 DB 测在
  // candidate-signals.db.test.ts / state.db.test.ts。同 personalized-difficulty.test.ts 显式登记理由。
  'src/server/mastery/family-key.test.ts',
  // YUK-348 (B1 four-engine soft-track inc-1) — BKT forward estimator 纯函数单测（result shape /
  // pLFinal 升降方向 / 空·极短序列 prior-echo 红线）。Pure no-DB: imports 仅 ./kt-estimator
  // （纯算术 + 命名常量，零 IO，无 @/db/client / postgres / drizzle / PgBoss）。soft-track 写者
  // 的 db 测在 kt-calibration.db.test.ts / kt_estimate_nightly.db.test.ts。src/server/mastery/**
  // 无 unit glob，故必须显式列出，否则 db config 的 src/**/*.test.ts glob 会把它扫进 testcontainer
  // 分区（personalized-difficulty.test.ts 同款）。
  'src/server/mastery/kt-estimator.test.ts',
  // YUK-361 Phase 3 Step B (Task 8 L2) — SelectionOrchestratorTask parse barrier +
  // 分桶格式化器. Pure no-DB: imports only ./selection-orchestrator (→
  // @/core/schema/selection-orchestrator Zod + `import type { CollectedSignal }`
  // which is type-only / erased — no @/db/client / postgres / drizzle / PgBoss).
  // src/server/ai/** has no unit glob, so this MUST be listed explicitly or the db
  // config's src/**/*.test.ts glob sweeps it into the testcontainer partition.
  'src/server/ai/selection-orchestrator.test.ts',
  // YUK-361 Phase 8 (Task 13) — 供给目标发现纯扫描器 + 路由规划单测. Pure no-DB:
  // imports 仅 ./target-discovery + ./route-planner——其 @/db/client 是 type-only/erased，
  // @/db/schema 是 table objects 不连库，@/server/mastery/state / domain / provenance /
  // selection-signals / theta / subjects/profile 全是纯函数或 type-only db。端到端的
  // discoverSupplyTargets + dispatcher 派发 db 测在 target-discovery.db.test.ts。
  // src/server/question-supply/** 无 unit glob，故必须显式列出，否则 db config 的
  // src/**/*.test.ts glob 会把它扫进 testcontainer 分区（item-prior.test.ts 同款）。
  'src/server/question-supply/target-discovery.test.ts',
  'src/server/ai/tools/registry.test.ts',
  'src/server/ai/tools/allowlists.test.ts',
  'src/server/ai/tools/mcp-bridge.test.ts',
  // M5-T3 (YUK-321) — copilotTools 组合根聚合器：纯 registry 操作，无 DB。
  'src/server/ai/tools/register-capability-tools.unit.test.ts',
  // YUK-203 U4 / L-memtool — search_memory_facts DomainTool. Pure DI unit: the
  // MemoryClient factory is stubbed, so no live Mem0 / pgvector / OpenAI env is
  // touched (the real createMemoryClient is never constructed in tests).
  'src/server/ai/tools/search-memory-facts.test.ts',
  // YUK-198 — pure (no-DB) Tavily remote MCP builder: reads TAVILY_API_KEY via
  // vi.stubEnv, returns a static McpHttpServerConfig. No live DB / AI / network.
  'src/server/ai/mcp/tavily.test.ts',
  // P5.1 / YUK-143 — pure (no-DB) budget constants + per-message context throttle.
  'src/server/ai/tools/budgets.test.ts',
  'src/server/ai/tools/context-throttle.test.ts',
  // M3 (YUK-317) — body-blocks-snippet / hub-dismiss / note-refine-triggers 三条
  // unit 条目已随 notes 域迁入 src/capabilities/notes/（重命名 *.unit.test.ts），
  // 由约定 glob 接管。editing-session / presence 留旧位置（dwell ⚖️ 争议行未裁）。
  // Editing-session state machine (heartbeat / idle timeout / force-apply /
  // defer-and-flush). Both @/db/client and presence/pg are vi.mock'd (PgPresenceStore
  // swapped for InMemoryPresenceStore), so no live DB is touched — fast unit. (YUK-97 P7)
  'src/server/artifacts/editing-session.test.ts',
  'src/server/events/cause-policy.test.ts',
  // src/server/export — the no-DB units (constants / csv / readme) run fast. The
  // wholesale `src/server/export/**/*.test.ts` glob was narrowed to plain
  // `*.test.ts` so the ②d reverse-lockstep test (reverse_lockstep.db.test.ts —
  // imports @/db/schema for table reflection) falls through to the db partition
  // like every other `.db.test.ts`, instead of tripping the unit-partition P0.
  'src/server/export/constants.test.ts',
  'src/server/export/csv.test.ts',
  'src/server/export/readme.test.ts',
  'src/server/http/**/*.test.ts',
  // YUK-258 — DOCX ingestion units. All three are pure no-DB: route-classify is
  // zip-parse only (fflate), markdown-segment is pure string→struct, convert
  // exercises the seam via an injected mock (NO real spawn / docker). The route
  // db test (app/api/ingestion/docx/route.test.ts) hits live Postgres → db
  // partition (NOT listed here). fastTestInclude is an explicit per-file allowlist
  // with no ingestion/** glob, so these must be enumerated or the db config's
  // src/**/*.test.ts glob would sweep them into the testcontainer partition.
  // YUK-250 — pure PDFium page renderer unit. Imports only pdf-render.ts +
  // sharp + @hyzyla/pdfium (WASM, no DB/R2/AI). Fixtures are static PDF bytes.
  // YUK-250 — encrypted-PDF error mapping; fully mocks @hyzyla/pdfium + sharp.
  // YUK-250 bot-review F1 — pure sha256Hex unit (crypto.subtle only, no DB/R2).
  // Guards content-addressing against byteOffset/byteLength view bugs.
  // YUK-214 (Strategy D · S1) — pure (no-DB) ingest→practice paper builder.
  // buildIngestionPaperToolState imports only @/core/schema/business (Zod);
  // @/db/* is type-only / pure table objects at this surface. The DB writer
  // (createIngestionPaper) + idempotency are covered by make-paper.db.test.ts
  // (db partition).
  // T-OC slice 2 (YUK-145): VLM StructureTask runner. Pure DI unit — injected
  // runTaskFn, no live DB / AI / R2. (sibling tencent_ocr_extract handler test
  // hits Postgres → db partition.)
  // YUK-227 S3 Slice A (F4): block-assembly spatial projection unit tests — pure
  // functions (isAllPlaceholderPageIndex / projectBlock). DB-backed integration
  // tests remain in block-assembly.test.ts (db partition).
  // T-OC slice A1 (YUK-145): the MistakeEnrollTask invoker is a pure DI unit —
  // injected runTaskFn, no live DB / AI. (sibling auto-enroll.test.ts hits
  // Postgres → db partition.)
  // T-OC slice 3 (YUK-145): the deterministic WorkflowJudge aggregator + the
  // auto-enroll flag config readers are pure (no DB / no LLM). The sibling
  // tagging.test.ts + auto-enroll.test.ts hit live Postgres → db partition.
  // YUK-253 — GLM-OCR engine swap. Both pure no-DB units: the client test mocks
  // global `fetch`, the parser test is pure (real fixtures). No @/db/client /
  // postgres / drizzle / PgBoss import → unit partition. The handler test
  // (tencent_ocr_extract.test.ts) hits live Postgres → db partition.
  'src/server/judge/**/*.test.ts',
  // YUK-239 (STB-5) — pure env-read guard for the background-job enqueue seam
  // (shouldEnqueueBackgroundJobs). No DB / pg-boss touched (vi.stubEnv only).
  // Lives at src/server/runtime-env.ts (NOT under src/server/boss/) precisely so
  // it stays out of the partition auditor's DB_TAINTED_DIRS.
  'src/server/runtime-env.test.ts',
  // YUK-216 S2 slice 1 — pure (no-DB) verify-gate framework + solve-check unit.
  // runSolveCheck takes an injected runTaskFn (mocks BOTH the SolutionGenerate
  // solver and the SemanticJudge open-question compare), and `db` is a `{}` stub
  // that the conservative semantic path only forwards — no live Postgres / AI. The
  // transitive @/db/client import (via question-contract → runSemanticJudge) is
  // type-only; same safe surface as the judges unit tests above.
  'src/server/quiz/verify-framework.test.ts',
  // YUK-225 (S2 slice 4) — pure (no-DB) units: skill resolver (fs fixture root),
  // few-shot block renderer (pure fn), profile thin-section schema parse.
  'src/server/quiz/fewshot-retrieve.render.test.ts',
  'src/subjects/quiz-gen-skills.test.ts',
  // YUK-228 (S3 Slice B) — pure (no-DB) note skill resolver (fs fixture root),
  // live SoT discovery, and double-sided cloze防御 (note vs quiz-gen-* prefix).
  'src/subjects/note-skills.test.ts',
  // YUK-284 (C2) — pure (no-DB) Copilot dialogue-methodology skill resolver
  // (fs fixture root + live SoT discovery). Cross-subject shared pack under
  // _shared/skills/copilot. MUST be listed here: the unit partition is an explicit
  // allowlist, not an import sniff (漏列 → vitest.unit.config.ts silent 0-collect).
  'src/subjects/copilot-skills.test.ts',
  'src/subjects/question-kind.test.ts',
  'src/subjects/profile-schema.thin-section.test.ts',
  // YUK-288 — resolveKnownSubjectId (pure, no-DB): genuine alias/id hit vs the
  // default-profile over-match fix for the derived ?subject= axis.
  'src/subjects/resolve-known-subject-id.test.ts',
  // M3 (YUK-317) — hub-mesh / rubric-validator.unit / tree.unit 三条 knowledge
  // unit 条目已随域迁入 src/capabilities/knowledge/（统一 *.unit.test.ts 命名），
  // 由约定 glob 接管。
  // P5.4-L2 / YUK-174 — pure (no-DB) adaptive-bias decision helpers
  // (computeGateBump / relation parse / findFeedbackCell). The DB-touching
  // getProposalFeedbackDigest is covered by adaptive-bias.test.ts (DB partition).
  'src/server/proposals/adaptive-bias.unit.test.ts',
  // Memory tests are mostly unit-mocked. The outbox real-path integration
  // test (triggers.outbox.test.ts, YUK-101 / ADR-0021) and the P5.2
  // activity-gated brief test (active-subjects.db.test.ts, YUK-143) hit live
  // Postgres and run in the DB partition — enumerate the unit tests here
  // instead of globbing so those .db.test.ts files fall through.
  'src/server/memory/active-subjects.test.ts',
  'src/server/memory/brief.test.ts',
  // Station 2A / YUK-185 — pure (no-DB) brief-writer unit (stubbed runTaskFn,
  // brace-slice parse, D3 id-subset filter, 4A cold-scope, 3A now/projection).
  // The end-to-end DB driver (brief-writer.db.test.ts) hits live Postgres and
  // falls through to the DB partition.
  'src/server/memory/brief-writer.test.ts',
  'src/server/memory/client.test.ts',
  'src/server/memory/scope_tagger.test.ts',
  'src/server/memory/triggers.test.ts',
  // P2 (YUK-342) — pure (no-DB) GLM reconcile LLM unit: mocks fetch, no live DB.
  'src/server/memory/reconcile-llm.test.ts',
  // P3 (YUK-351) — pure (no-DB) mem0 READ wrapper: stubbed MemoryClient.search,
  // asserts soft-superseded filtering + per-kind recency rerank. No live DB.
  'src/server/memory/search-memories.test.ts',
  'src/server/r2.test.ts',
  // P2a (YUK-312) — review 域 5 条 unit 条目已随模块迁入 src/capabilities/practice/，
  // 由约定 glob（src/capabilities/**/*.unit.test.ts）自动接管，无需再登记。
  // YUK-203 U6 — pure (no-DB) state-machine JSON sanitizer + parseTurnOutput /
  // parseHintTurn control-char resilience tests. Imports only ./json-sanitize,
  // ./teaching, ./solve — no live DB / AI touches.
  'src/server/orchestrator/json-sanitize.test.ts',
  'src/server/session/guards.test.ts',
  'src/server/session/index.test.ts',
  'src/subjects/math/fixtures/index.test.ts',
  'src/subjects/math/fixtures/derivation.test.ts',
  'src/subjects/math/fixtures/derivation-with-images.test.ts',
  'src/subjects/physics/fixtures/schema.test.ts',
  'src/subjects/wenyan/fixtures/index.test.ts',
  // U7 (YUK-203) — pure (no-DB) profile→TS-literal serializer round-trip. Imports
  // only the three profile.ts fixtures + ./serialize (no @/db / pg-boss / drizzle);
  // writes/imports a temp .ts under src/subjects/ then rm's it. → unit partition.
  'src/subjects/serialize.test.ts',
  'src/ui/**/*.test.ts',
  'src/ui/**/*.test.tsx',
  'tests/core/**/*.test.ts',
  'tests/schema/**/*.test.ts',
  'tests/subjects/**/*.test.ts',
  'tests/integration/judge-gap-audit.test.ts',
  'tests/integration/session-single-owner.test.ts',
  // Audit 2026-06-06 G8-docs — pure-fs doc invariants (YUK-242/243/244), no DB/AI.
  'tests/integration/audit-docs-invariant.test.ts',
  'tests/integration/step12-docs-invariant.test.ts',
  'tests/integration/step9-invariant-audit.test.ts',
];

export const migrationSmokeInclude = ['tests/integration/migration-smoke.test.ts'];

export const sharedExclude = configDefaults.exclude;
