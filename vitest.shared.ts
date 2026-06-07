import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const resolveConfig = {
  alias: { '@': path.resolve(__dirname, 'src') },
};

export const allTestInclude = [
  '*.test.ts',
  'src/**/*.test.ts',
  'app/**/*.test.ts',
  'workers/src/**/*.test.ts',
  'tests/**/*.test.ts',
  'scripts/**/*.test.ts',
];

export const fastTestInclude = [
  'middleware.test.ts',
  'scripts/**/*.test.ts',
  // YUK-263 — pure (no-DB) unit for the globalThis pool-cache HMR guard in
  // src/db/client.ts. `postgres` is vi.mock'd and the only @/db/client import is
  // a dynamic `await import()`, so no live Postgres is touched → unit partition.
  'src/db/client.test.ts',
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
  'src/server/ai/tools/registry.test.ts',
  'src/server/ai/tools/allowlists.test.ts',
  'src/server/ai/tools/mcp-bridge.test.ts',
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
  'src/server/artifacts/body-blocks-snippet.test.ts',
  // In-memory editing-session state machine (heartbeat / idle timeout /
  // force-apply / defer-and-flush). persistNoteRefineApply is vi.mock'd, so
  // no live DB is touched — fast unit. (YUK-97 P7)
  'src/server/artifacts/editing-session.test.ts',
  // Pure (no-DB) coverage for the hub-dismiss helpers (appendSuppressedRef /
  // buildRemoveAutoLinkPatch). The sibling DB tests (boss/handlers/
  // hub_auto_sync_nightly, app/api/hubs/[id]/dismiss-link/route) stay in the db
  // partition because they hit live Postgres.
  'src/server/artifacts/hub-dismiss.test.ts',
  'src/server/artifacts/note-refine-triggers.test.ts',
  // YUK-171 fail-safe degradation unit: a MOCKED ioredis client (no container) +
  // vi.mock'd persistNoteRefineApply, so no live Redis / Postgres is touched —
  // fast no-DB unit. The sibling redis.integration.test.ts (real testcontainer)
  // stays in the db partition.
  'src/server/artifacts/presence/redis.test.ts',
  // Pure dependency-injection unit: runCopilotChat takes runAgentTaskFn /
  // buildMcpServerFn / writeEventFn as injected vi.fn() deps, so no live DB /
  // AI is touched. The transitive `@/db/client` import (via events/queries +
  // effective-truth) is type-only; only `@/db/schema` (pure table objects) +
  // drizzle-orm (query builder) load at runtime — same safe surface the
  // sibling mcp-bridge / allowlists unit tests already exercise. (YUK-97 P7)
  'src/server/copilot/chat.test.ts',
  'src/server/events/cause-policy.test.ts',
  'src/server/export/**/*.test.ts',
  'src/server/http/**/*.test.ts',
  'src/server/ingestion/crop.test.ts',
  // YUK-258 — DOCX ingestion units. All three are pure no-DB: route-classify is
  // zip-parse only (fflate), markdown-segment is pure string→struct, convert
  // exercises the seam via an injected mock (NO real spawn / docker). The route
  // db test (app/api/ingestion/docx/route.test.ts) hits live Postgres → db
  // partition (NOT listed here). fastTestInclude is an explicit per-file allowlist
  // with no ingestion/** glob, so these must be enumerated or the db config's
  // src/**/*.test.ts glob would sweep them into the testcontainer partition.
  'src/server/ingestion/docx/route-classify.test.ts',
  'src/server/ingestion/docx/markdown-segment.test.ts',
  'src/server/ingestion/docx/convert.test.ts',
  'src/server/ingestion/figure_attach.test.ts',
  // YUK-250 — pure PDFium page renderer unit. Imports only pdf-render.ts +
  // sharp + @hyzyla/pdfium (WASM, no DB/R2/AI). Fixtures are static PDF bytes.
  'src/server/ingestion/pdf-render.test.ts',
  // YUK-250 — encrypted-PDF error mapping; fully mocks @hyzyla/pdfium + sharp.
  'src/server/ingestion/pdf-render-encryption.test.ts',
  // YUK-250 bot-review F1 — pure sha256Hex unit (crypto.subtle only, no DB/R2).
  // Guards content-addressing against byteOffset/byteLength view bugs.
  'src/server/ingestion/persist-image-asset.unit.test.ts',
  // YUK-214 (Strategy D · S1) — pure (no-DB) ingest→practice paper builder.
  // buildIngestionPaperToolState imports only @/core/schema/business (Zod);
  // @/db/* is type-only / pure table objects at this surface. The DB writer
  // (createIngestionPaper) + idempotency are covered by make-paper.db.test.ts
  // (db partition).
  'src/server/ingestion/make-paper.unit.test.ts',
  // T-OC slice 2 (YUK-145): VLM StructureTask runner. Pure DI unit — injected
  // runTaskFn, no live DB / AI / R2. (sibling tencent_ocr_extract handler test
  // hits Postgres → db partition.)
  'src/server/ingestion/structure.test.ts',
  // YUK-227 S3 Slice A (F4): block-assembly spatial projection unit tests — pure
  // functions (isAllPlaceholderPageIndex / projectBlock). DB-backed integration
  // tests remain in block-assembly.test.ts (db partition).
  'src/server/ingestion/block-assembly.unit.test.ts',
  // T-OC slice A1 (YUK-145): the MistakeEnrollTask invoker is a pure DI unit —
  // injected runTaskFn, no live DB / AI. (sibling auto-enroll.test.ts hits
  // Postgres → db partition.)
  'src/server/ingestion/mistake_enroll.test.ts',
  // T-OC slice 3 (YUK-145): the deterministic WorkflowJudge aggregator + the
  // auto-enroll flag config readers are pure (no DB / no LLM). The sibling
  // tagging.test.ts + auto-enroll.test.ts hit live Postgres → db partition.
  'src/server/ingestion/workflow-judge.test.ts',
  'src/server/ingestion/workflow-judge-config.test.ts',
  'src/server/ingestion/tencent_mark.test.ts',
  'src/server/ingestion/tencent_mark_parser.test.ts',
  // YUK-253 — GLM-OCR engine swap. Both pure no-DB units: the client test mocks
  // global `fetch`, the parser test is pure (real fixtures). No @/db/client /
  // postgres / drizzle / PgBoss import → unit partition. The handler test
  // (tencent_ocr_extract.test.ts) hits live Postgres → db partition.
  'src/server/ingestion/glm_ocr.test.ts',
  'src/server/ingestion/glm_ocr_parser.test.ts',
  'src/server/ingestion/vision.test.ts',
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
  'src/subjects/question-kind.test.ts',
  'src/subjects/profile-schema.thin-section.test.ts',
  // Pure (no-DB) set-algebra unit for hub mesh curation (YUK-95 P5 Lane-C). The
  // sibling DB handler test (boss/handlers/hub_auto_sync_nightly) stays in the
  // db partition because it hits live Postgres.
  'src/server/knowledge/hub-mesh.test.ts',
  // P5.4 / YUK-143 — pure (no-DB) stable-contract unit for the proposal rubric
  // validator (evidence-window const + RubricVerdict / gate set). The
  // gate-behavior + RB-7 regression tests (rubric-validator.test.ts) hit live
  // Postgres → db partition.
  'src/server/knowledge/rubric-validator.unit.test.ts',
  // YUK-236 [STB-2] — pure (no-DB) coverage for the loadTreeSnapshot OOM-guard
  // truncation warn. Imports only ./tree (value-imports @/db/schema pure table
  // objects + drizzle-orm; @/db/client is type-only). The `.limit(5000)` query
  // bound + parent-chain semantics stay in tree.test.ts (db partition).
  'src/server/knowledge/tree.unit.test.ts',
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
  'src/server/r2.test.ts',
  'src/server/review/activity-ref.test.ts',
  'src/server/review/fsrs.test.ts',
  'src/server/review/rating-advisor.test.ts',
  // U5 (YUK-203) — pure (no-DB) shim: readPaperSections + resolveSlotAssignment
  // import only @/core/schema/business (Zod). The end-to-end DB driver
  // (paper-cycle.test.ts) hits live Postgres → falls through to the DB partition.
  'src/server/review/paper-sections.test.ts',
  // YUK-214 (Strategy D · S1) — pure (no-DB) source-mapping unit. Imports only
  // @/server/review/practice-read; @/db/client is type-only and @/db/schema is
  // pure table objects (no connection), same safe surface as paper-sections.
  // The DB-touching getPracticeList is covered by the db-partition tests.
  'src/server/review/practice-read.unit.test.ts',
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
  'app/api/ai/*/route.test.ts',
  // Health route test mocks @/db/client before importing the route, so it has no
  // live-Postgres dependency and belongs in the no-Docker unit partition (YUK-134).
  'app/api/health/route.test.ts',
  'app/api/study-log/route.test.ts',
  // Revert route mocks @/db/client + the revert primitive before importing the
  // route, so it has no file-level DB import → unit partition (B1b, YUK-164).
  // `*` matches the literal `[id]` dynamic segment (mirrors app/api/ai/*/...).
  'app/api/ingestion/*/revert/route.test.ts',
  // Coach TodayPlan read route mocks @/db/client + the reader before import →
  // no live DB → unit partition (YUK-143, P0.4).
  'app/api/coach/today-plan/route.test.ts',
  // T-SQ Q4 — QuizGen trigger route mocks @/server/boss/client before importing
  // the route; it only validates + enqueues (no @/db/client import), so it has
  // no live-Postgres dependency → unit partition (search-grounded QuizGen wave).
  'app/api/questions/quiz-gen/route.test.ts',
  // YUK-234 (SEC-4) — pure Zod-parse unit for the import request-body bounds
  // (per-array .max() ceilings). schema.ts has no DB / R2 / AI import; the
  // route's DB-backed behavior stays in import/route.test.ts (db partition).
  // `*` matches the literal `[id]` dynamic segment (mirrors the revert glob).
  'app/api/ingestion/*/import/schema.test.ts',
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
