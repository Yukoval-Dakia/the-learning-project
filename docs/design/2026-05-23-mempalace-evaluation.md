# mempalace Sidecar Evaluation — Phase A

> **Status**: Phase A complete (this doc is the deliverable).
> **Date**: 2026-05-23
> **Recommendation**: **NO-GO for Phase B as currently scoped** (see §"GO / NO-GO Decision"). Move forward with TS-native alternative.
> **Linear**: [YUK-34](https://linear.app/yukoval-studios/issue/YUK-34)
> **Scope gate**: Phase A = read-only research + throwaway PoC + this doc. Phase B (docker-compose change / sync pipeline / Dreaming rewire / ADR-0016) **not entered**; alternative path scoped in §"If NO-GO" below.

---

## Context

This project (a single-user TS/Next.js learning tool, self-hosted on NAS) needs a long-running memory layer for two functions documented in [ADR-0015](../adr/0015-learning-record-memory-brief.md) §2:

1. **`memory_brief_note`** — rolling per-`scope_key` summary (recent week / months / long term) over `event` + `learning_record`. **Write path TBD** ("Dreaming-owned" forward-locking decision); ADR explicitly forbids inline write paths until the Dreaming agent lands.
2. **Semantic retrieval over past attempts** — "find similar past mistakes" / "what does the user know about Y" queries that pure SQL filters can't answer well (e.g. "where did I confuse classical particles with modern punctuation").

[mempalace](https://github.com/MemPalace/mempalace) — a Python local-first memory system (52.6k★, 6.9k forks, active since 2026-04-05) — was floated as the sidecar that would fill both. Per [ADR-0001](../adr/0001-typescript-monolith-with-python-sidecar-escape-hatch.md), Python in this stack is an **escape hatch** — only justified when the workload requires local model weights or pandas-class data processing. Local-embedding semantic search arguably qualifies.

This evaluation answers: does mempalace satisfy ADR-0001 (escape-hatch criterion), ADR-0007 (single-user), ADR-0012 (events = SoT), and the ADR-0015 forward-locked Dreaming role — without becoming a competing source of truth?

## Verify 1 — Single-user assumption — ✅ **PASS**

mempalace is explicitly designed single-user. No `user_id` columns, no tenant isolation, no per-user data scoping anywhere in the codebase. Configuration loads from a single home-directory path (`~/.mempalace/config.json` or `--palace <PATH>`). The data model — *wings* (people/projects) → *rooms* (topics) → *drawers* (content) — has no concept of an owning user; the single user is implicit.

For our single-user NAS deploy: zero integration friction on this axis. One mempalace instance per palace path; concurrency is controlled by file-level locks (see Verify 2).

**Cite**: README §"What it is" — palace is wings/rooms/drawers, no user dimension. `mempalace/config.py` — single-path config. ADR-0007 alignment ✓.

## Verify 2 — Source-of-truth + sync pipeline — ⚠️ **CAVEAT (architectural mismatch)**

mempalace is **not designed to be a derived index over an external SoT**. Its ingest assumes "files on disk are the source": `mempalace mine <dir>` walks a directory and indexes content; `mempalace mine <convo-dir> --mode convos` ingests conversation exports (Claude Code / ChatGPT / Slack). There is no native "structured row ingest" API — you must materialize rows to files first.

**Concrete consequences for this project:**

1. **Sync pipeline = real engineering**. Each `event` row → markdown file → re-mine. For our SoT (`event` + `learning_record` in Postgres), we'd need an ETL Python script (or TS shell-out) that:
   - On every new event, emit `<event_id>.md` to disk.
   - Periodically run `mempalace mine` (or `sync` to prune deletions).
   - Reconcile sqlite+HNSW divergence (see issue spike around #1581, #1586 — HNSW corruption under concurrent clients).
2. **Crash semantics**: mempalace's SQLite is the persistence layer; HNSW indices are async-flushed ephemera that auto-rebuild from SQLite on detection of mtime drift. Losing the palace dir would require full re-mine — recoverable from our Postgres SoT, but throughput-bounded by re-embedding 34k+ events.
3. **Does it respect ADR-0012 "events = SoT"?** *Only if* we treat mempalace state as 100% rebuildable from `event` table and never write user-facing data to it directly. This is enforceable by convention but the framework doesn't help — there's no "derived view" pattern in mempalace itself.

**Cite**: `mempalace mine` CLI surface (file-based ingest only — verified locally: `mempalace --help`); `mempalace/diary_ingest.py` (SHA256 dedup on file hashes); README §"How it works" — verbatim text storage, no structured ingest documented; open issues #1581/#1586 on HNSW concurrency.

## Verify 3 — Embedding model — ⚠️ **CAVEAT (locked + Chinese mediocre)**

Default backend is **ChromaDB** (per README); ChromaDB's default embedding is **all-MiniLM-L6-v2** (384-dim, ONNX, on-device). The README states "The retrieval layer is pluggable" — alternative backends drop in via `mempalace/backends/base.py`. So:
- **Embedding model swap within ChromaDB backend**: not exposed in mempalace config (open community asks: #1559, #1563). Effectively locked to all-MiniLM-L6-v2.
- **Backend swap**: possible per the documented `BackendBase` interface, but requires writing a new backend module (non-trivial — replicate the wings/rooms/drawers semantics).

**Chinese-content quality (PoC observation)**: all-MiniLM-L6-v2 is multilingual but mediocre on Chinese. Our PoC queries hit `0.15-0.27` cosine on the most relevant rows (see Verify 5), with off-topic teach_messages frequently outranking the target attempt rows.

**Re-index story**: changing the embedding model invalidates all existing 384-dim vectors → full re-mine of all sources required. No incremental migration. CHANGELOG explicitly notes this.

**Cost**: zero API cost (everything on-device). Disk: ~300 MB for the model + ChromaDB SQLite + HNSW segments.

**Cite**: README §"What it is" (ChromaDB default, pluggable interface). Issues #1559, #1563 (community asks for swappable embedding models, unresolved). Empirical low cosines from Verify 5 below.

## Verify 4 — Breaking-change history — ✅ **PASS (active maintenance)**

Release cadence: 8 releases over 33 days (v3.0.0 2026-04-06 → v3.3.5 2026-05-10). Last push 2026-05-23. 542 open issues with recent spike on data-integrity edge cases (HNSW corruption under concurrent MCP server + CLI + auto-ingest).

Breaking changes since v3.0.0:
- **v3.3.5** (2026-05-10): tunnel validation tightened (`create_tunnel()` rejects non-existent endpoints); knowledge-graph dates require full `YYYY-MM-DD`; diary agent names auto-lowercased — legacy entries require `mempalace repair`.
- **v3.3.3**: case-sensitivity enforcement for diary ops (requires `mempalace repair`).
- **v3.3.0**: closet layer + BM25 hybrid + diary ingest + cross-wing tunnels — additive, no API break in MCP tool surface.

All breakage has explicit migration commands (`mempalace repair`). Upgrade pain: **low-to-medium** for a single user — read CHANGELOG before each minor bump.

**Maintenance signal**: aggressive (43 issues closed in v3.3.5 alone). Project is young (48 days), star count and issue spike both reflect early-adopter pain — not a stable plateau yet.

**Cite**: `gh api /repos/MemPalace/mempalace/releases` (verified 8 releases in window). CHANGELOG.md.

## Verify 5 — Real PoC (throwaway env)

**Setup**:
- `uv tool install mempalace` → installed v3.3.5 cleanly into `~/.local/share/uv/tools/mempalace/`. Two executables on PATH: `mempalace`, `mempalace-mcp`.
- Source data: local `loom` Docker Postgres at 2026-05-23 — 34 events (11 attempt / 9 teach_message / 3 review / 11 misc), 4 learning_records (test fixtures, mostly empty payloads), 0 memory_brief_notes. Predominantly wenyan classical-Chinese content.
- ETL: 38 markdown files via `/tmp/mempalace-poc/convert.py` (one per event/record, with answer + judge feedback + raw payload).
- Ingest: `mempalace mine /tmp/mempalace-poc/data` → 45 drawers in one "general" room. (`mempalace init` is interactive — failed in non-TTY shell; `mine` worked standalone.)

**Q1 — semantic precision over knowledge concept**
> Query: `"我在 wenyan 语气词上的掌握情况"`
> SQL baseline equivalent: `SELECT * FROM event WHERE payload @> '{"referenced_knowledge_ids": ["seed:wenyan:duanju"]}'` — returns the 4-6 attempt events on 语气词 (mood particles).

Top-5 mempalace results, ranked by cosine:
1. `stxgvlmvp8qvx8n332ymtgih.md` — attempt on `seed:wenyan:shici` (实词, **wrong concept**), cosine 0.266
2. (omitted — `seed:wenyan:duanju` attempt, expected, cosine ~0.25)
3. `stxgvlmvp8qvx8n332ymtgih.md` again — duplicate framing
4. teach_message on 断句, cosine 0.245
5. `qa_artifact_1.md` — generate-action artifact, cosine 0.243

**Verdict**: relevant set returned, but the embedding cannot distinguish between `shici` (实词 = content words) and `duanju` (语气词 = mood particles) — these are two distinct knowledge concepts that should not rank equivalently. The SQL filter trivially gives the exact `duanju` set; mempalace blurs concept boundaries.

**Q2 — semantic match over paraphrased content**
> Query: `"where did I confuse modern punctuation with classical particles"`
> SQL baseline: requires keyword search across `payload->>'answer_md'`. Target row has answer `"现代逗号"` ("modern comma") to a 语气词 question — would require a manual keyword guess to find via SQL.

Top-5 mempalace results:
1. `qa_artifact_1.md` — variant artifact about 之字用法, cosine 0.21
2. teach_message on 断句, cosine 0.20
3. teach_message — agent's "断句乃句读之法", cosine 0.20
4. teach_message — duplicate framing, cosine 0.20
5. **`didfgf78xhb3urjrud48a4if.md`** — the target "现代逗号" attempt, cosine 0.197 ✓ but rank 5

**Verdict**: mempalace **did find** the paraphrased target ✓ — this is the genuine win-case for semantic retrieval. But **rank 5 of 5 with cosine 0.197** behind 4 teach_messages that are conceptually adjacent but not the target. A user asking "where did I make this confusion" gets the right answer at position 5, surrounded by less-precise hits. Marginal value over SQL keyword search with `LIKE '%现代%'` or `LIKE '%逗号%'`.

**Q3 — cluster recent attempts by error type**
> Query: `"incorrect attempts wrong answer mistakes"`
> SQL baseline: `SELECT * FROM event WHERE action='attempt' AND payload->>'judge_score' = '0'` — exact.

Top-5 results: 2 of 5 are actual incorrect attempts (`kyyfb4gybl020ajdfqsjlb56` "不知道", `didfgf78xhb3urjrud48a4if` "现代逗号"); 3 are correct-attempt or teach_message noise.

**Verdict**: **SQL wins decisively**. mempalace doesn't expose structured filters; it can semantically match the word "incorrect" but can't filter by `judge_score=0`. Without structured-field awareness, semantic search over a structured domain is strictly worse than SQL.

**PoC summary**: mempalace's value-add over SQL is real **only for Q2-style fuzzy-paraphrase retrieval**, and even there the ranking quality is mediocre on Chinese content (cosine 0.197 for the genuine match, behind near-misses). For Q1 (concept distinction) and Q3 (structured filter), SQL is strictly better.

## GO / NO-GO Decision

**NO-GO for Phase B as scoped.**

### Why

1. **Architectural mismatch with our actual ADR-0015 §2 need**. mempalace explicitly **does not summarize** — README: "It does not summarize, extract, or paraphrase." But ADR-0015 §2 `memory_brief_note` is **exactly a 3-window summary**, not retrieval. The right tool for our forward-locked Dreaming role is an LLM summarizer over filtered events, **not** a verbatim-retrieval index. mempalace solves a different problem.

2. **Wins are marginal where mempalace does apply**. Semantic retrieval over our event log gave a usable Q2 result (paraphrase match) — but at rank 5 with cosine 0.197, in the noise band. Multilingual all-MiniLM-L6-v2 on Chinese content underdelivers. SQL filters or keyword search recover most of the value at zero infra cost.

3. **Sync pipeline cost is real**. To make mempalace useful as a derived index over our `event` SoT, Phase B would require: event → markdown ETL, periodic mine, sqlite/HNSW divergence reconciliation, NAS-Docker compose change (sub-0z), backup story for the palace dir. Per [ADR-0001](../adr/0001-typescript-monolith-with-python-sidecar-escape-hatch.md), the Python sidecar trigger is "needs to run model weights" — we'd be paying that cost for marginal semantic-retrieval improvement on a corpus that doesn't benefit much.

4. **Concurrency risk on NAS**. Open issues #1581/#1586 show real HNSW corruption under concurrent MCP server + CLI + auto-ingest. Our NAS setup (Cloudflare Tunnel + Next + Postgres + would-be mempalace) is exactly the multi-client topology that exposes these bugs. Adds operational fragility.

5. **TS-native alternative is cheaper and a better fit** (see below).

### If NO-GO — TS-native alternative for both needs

**For `memory_brief_note` (ADR-0015 §2)** — implement the Dreaming agent in TS, no sidecar:
- Cron / pg-boss job scans `event` table by `scope_key` partition (subject_id / topic).
- LLM summarizer (Claude via existing `src/server/ai/runner.ts`) produces 3-window markdown.
- Write goes through `src/server/dreaming/brief.ts` (forward-locked path per ADR-0015 §2).
- Cost: 1-2 day implementation; reuses existing AI runner infra.

**For semantic retrieval over events** (the Q2 use case) — if we ever genuinely need it:
- Compute embeddings on event insert via existing AI SDK (Voyage / Anthropic / OpenAI embedding model — better Chinese quality than all-MiniLM).
- Store as `vector(N)` column on `event` table (Postgres `pgvector` extension); ANN index on it.
- Cosine similarity query in plain SQL — `ORDER BY embedding <=> query_embedding`.
- Cost: 1 migration + 1 embedding job + 1 query helper. ~1 day. **No Python, no new container, no new lockfile.**

This alternative path satisfies both real needs without violating ADR-0001's "Python is escape hatch" rule. The ADR-0001 trigger ("needs model weights") is **not** met — Postgres + Anthropic/Voyage embeddings via the existing TS AI SDK covers the use case.

### Phase B cost estimate (declined)

For record, had we gone GO, Phase B would have been: docker-compose update (sub-0z) + sync pipeline scaffold (~3-5 days) + Dreaming rewire to call mempalace MCP (~2 days) + a follow-up ADR (mempalace as derived memory index) + retrieval-quality tuning. Estimate ~5-8 engineering days, ongoing maintenance cost for the second runtime stack. Not justified by the PoC findings.

## Implications for ADR-0015 §2 forward lock

ADR-0015 §2 forward-locked `memory_brief_note` write path to "Dreaming agent, expected path `src/server/dreaming/brief.ts`, Phase 2C". This evaluation **does not change** that decision — only narrows the implementation language to TS (no Python sidecar). The Dreaming agent design is still TBD and remains a Phase 2C deliverable. The actual follow-up ADR codifying the TS-native memory path is **ADR-0017** ([0017-memory-mem0-plus-brief-layer.md](../adr/0017-memory-mem0-plus-brief-layer.md), draft on PR #102, tracked by [YUK-37](https://linear.app/yukoval-studios/issue/YUK-37)). The number `ADR-0016` is **not** the memory ADR — it was already taken by `0016-openai-codex-subscription-provider-evaluation.md` at the time of this doc's writing — but that ADR is **not** part of Phase A scope.

## References

- mempalace upstream: <https://github.com/MemPalace/mempalace>
- mempalace v3.3.5 CHANGELOG entry (breaking changes)
- ADR-0001 (TypeScript monolith + Python sidecar escape hatch)
- ADR-0007 (single-user assumption)
- ADR-0012 (mastery as derived view)
- ADR-0015 (learning_record + memory_brief_note as first-class entities)
- PoC artifacts: `/tmp/mempalace-poc/` (throwaway, deleted after PR merge — see Anchor below)
- Linear: [YUK-34](https://linear.app/yukoval-studios/issue/YUK-34) (Memory Module — mempalace Sidecar Evaluation / Phase A milestone)
