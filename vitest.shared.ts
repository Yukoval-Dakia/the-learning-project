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
  'src/__tests__/**/*.test.ts',
  'src/ai/**/*.test.ts',
  'src/core/**/*.test.ts',
  'src/server/ai/judges/**/*.test.ts',
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
  'src/server/ingestion/figure_attach.test.ts',
  // T-OC slice 2 (YUK-145): VLM StructureTask runner. Pure DI unit — injected
  // runTaskFn, no live DB / AI / R2. (sibling tencent_ocr_extract handler test
  // hits Postgres → db partition.)
  'src/server/ingestion/structure.test.ts',
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
  'src/server/ingestion/vision.test.ts',
  'src/server/judge/**/*.test.ts',
  // Pure (no-DB) set-algebra unit for hub mesh curation (YUK-95 P5 Lane-C). The
  // sibling DB handler test (boss/handlers/hub_auto_sync_nightly) stays in the
  // db partition because it hits live Postgres.
  'src/server/knowledge/hub-mesh.test.ts',
  // P5.4 / YUK-143 — pure (no-DB) stable-contract unit for the proposal rubric
  // validator (evidence-window const + RubricVerdict / gate set). The
  // gate-behavior + RB-7 regression tests (rubric-validator.test.ts) hit live
  // Postgres → db partition.
  'src/server/knowledge/rubric-validator.unit.test.ts',
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
  'src/server/session/guards.test.ts',
  'src/server/session/index.test.ts',
  'src/subjects/math/fixtures/index.test.ts',
  'src/subjects/math/fixtures/derivation.test.ts',
  'src/subjects/math/fixtures/derivation-with-images.test.ts',
  'src/subjects/physics/fixtures/schema.test.ts',
  'src/subjects/wenyan/fixtures/index.test.ts',
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
  'tests/core/**/*.test.ts',
  'tests/schema/**/*.test.ts',
  'tests/subjects/**/*.test.ts',
  'tests/integration/judge-gap-audit.test.ts',
  'tests/integration/session-single-owner.test.ts',
  'tests/integration/step12-docs-invariant.test.ts',
  'tests/integration/step9-invariant-audit.test.ts',
];

export const migrationSmokeInclude = ['tests/integration/migration-smoke.test.ts'];

export const sharedExclude = configDefaults.exclude;
