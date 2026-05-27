# T-37 Mem0 spike findings (Wave 1 worktree A lane subagent)

**Doc 日期**：2026-05-27
**Lane**：`lane/t37-brief-writer` (worktree A)
**Parent driver**：[docs/superpowers/plans/2026-05-27-t37-brief-writer-driver.md](2026-05-27-t37-brief-writer-driver.md)
**Status**：implementation complete in lane; validation green except external
Chinese embedding recall cannot be truthfully executed on this machine without an
`OPENAI_API_KEY`.

---

## §1 Spike scope (per driver §1.1 deliverable 1)

Verify 4 propositions before committing to deliverables 2-7:

1. Mem0 TS SDK on current OSS version → API shape suitable for our use
2. pgvector adapter in Mem0 → can connect to project Postgres
3. LLM provider swap → can route Mem0's internal LLM calls to xiaomi/mimo
4. Chinese embedding quality → ≥ 60% recall on PoC dataset

---

## §2 What worked (verified)

### §2.1 SDK shape — Mem0 `mem0ai@3.0.4` OSS submodule

`import { Memory } from 'mem0ai/oss'` exposes the runtime class we need.

Public surface (`node_modules/mem0ai/dist/oss/index.d.ts:344-417`):

```ts
class Memory {
  constructor(config?: Partial<MemoryConfig>);
  static fromConfig(configDict: Record<string, any>): Memory;
  add(messages: string | Message[], config: AddMemoryOptions): Promise<SearchResult>;
  search(query: string, config: SearchMemoryOptions): Promise<SearchResult>;
  get(memoryId: string): Promise<MemoryItem | null>;
  getAll(config: GetAllMemoryOptions): Promise<SearchResult>;
  update(memoryId: string, data: string): Promise<{ message: string }>;
  delete(memoryId: string): Promise<{ message: string }>;
  deleteAll(config: DeleteAllMemoryOptions): Promise<{ message: string }>;
}
```

`AddMemoryOptions` accepts `{ userId, agentId, runId, metadata, filters, infer }` —
single-user invariant (`userId: 'self'`) maps to `userId` field directly. ADR-0007
single-user constraint enforceable at our wrapper boundary.

### §2.2 pgvector adapter — `PGVector` class is real

`node_modules/mem0ai/dist/oss/index.d.ts:968-995` declares the class; the
factory at `index.js:4906` maps `provider: 'pgvector'` to it. Config shape:

```ts
interface PGVectorConfig {
  dbName: string;
  user: string;
  password: string;
  host: string;
  port: number;
  embeddingModelDims: number;
  diskann?: boolean;
  hnsw?: boolean;
}
```

Note: takes raw connection params, **not** a connection string. Our wrapper
needs to parse `DATABASE_URL` into components — straightforward.

### §2.3 LLM provider swap — works via env, NOT via config

`AnthropicLLM` in Mem0 (`index.js:386-423`) calls `new Anthropic({ apiKey })`
without any `baseURL`. **It does NOT accept a baseURL config field.**

But `@anthropic-ai/sdk@0.96.0` (already installed) reads `ANTHROPIC_BASE_URL`
from env (`node_modules/@anthropic-ai/sdk/src/client.ts:470,480`). So the swap
path is:

```
process.env.ANTHROPIC_BASE_URL = 'https://api.xiaomimimo.com/anthropic';
process.env.ANTHROPIC_API_KEY   = process.env.XIAOMI_API_KEY;
```

set at module-init time, BEFORE constructing `Memory({ llm: { provider: 'anthropic', config: { model: 'mimo-v2.5-pro' } } })`.

**Caveat**: this hijacks the global env vars for the whole process. Our
existing `src/server/ai/providers.ts` already sets ANTHROPIC_BASE_URL per
subprocess spawn — the worker process shares one env. Acceptable as long as
**no Mem0 call ever competes with a direct `@anthropic-ai/sdk` call inside the
same process expecting a different baseURL**. Worker process: only Mem0 + 
existing claude-agent-sdk both want xiaomi → consistent → safe.

App process: same — both want xiaomi by default per `providers.ts`.

---

## §3 What broke (blockers surfacing for master decision)

### §3.1 BLOCKER A — Chinese embedder: ADR-0017 spec ↔ SDK reality drift

**ADR-0017 line 109** says:
> mitigated by configuring embedding to Voyage / Anthropic via Mem0's provider hook

**Reality** (`node_modules/mem0ai/dist/oss/index.js:4837-4860`):

```js
class EmbedderFactory {
  static create(provider, config) {
    switch (provider.toLowerCase()) {
      case "openai":         return new OpenAIEmbedder(config);
      case "ollama":         return new OllamaEmbedder(config);
      case "lmstudio":       return new LMStudioEmbedder(config);
      case "google": case "gemini": return new GoogleEmbedder(config);
      case "azure_openai":   return new AzureOpenAIEmbedder(config);
      case "langchain":      return new LangchainEmbedder(config);
      default: throw new Error(`Unsupported embedder provider: ${provider}`);
    }
  }
}
```

- **No `voyage`** embedder.
- **No `anthropic`** embedder (Anthropic does not have an embeddings API).
- xiaomi/mimo endpoint is Anthropic-protocol-only → cannot serve embeddings.

Concrete options for Chinese embedding, ranked by impl effort:

| Option | Pro | Con | API key need |
|---|---|---|---|
| **A. `openai` embedder, baseURL→xiaomi if mimo exposes /v1/embeddings** | Native, zero LLM mismatch | Untested whether xiaomi exposes OpenAI-protocol embedding endpoint | `XIAOMI_API_KEY` (or separate) |
| **B. `openai` embedder, real OpenAI `text-embedding-3-small`** | Cheap ($0.02/M tok), multilingual, well-tested | New external dep / API key | `OPENAI_API_KEY` (new) |
| **C. `google` embedder, `text-embedding-004`** | Strong Chinese support, multilingual | New external dep / API key | `GOOGLE_API_KEY` (new) |
| **D. `ollama` embedder, `bge-m3` local** | No external API; Chinese-strong | Heavy on NAS (~2GB RAM); ollama runtime to deploy | None |
| **E. `langchain` wrapper, custom HTTP client** | Maximum flexibility | Most code; new abstraction; LangChain dep | depends on backing service |

**Master decision 2026-05-27**: use **B** (OpenAI direct) for PoC. The wrapper
requires `OPENAI_API_KEY` and configures `text-embedding-3-small`; missing key
is a hard configuration error, not a fallback path.

`OpenAIEmbedder` does accept `baseURL` config (`index.js:118-120`) so option A
is verifiable with a single test call if xiaomi/mimo's `/v1/embeddings` is wired.
**Test deferred — requires master to ask xiaomi/mimo or attempt blind probe.**

### §3.2 BLOCKER B — sandbox docker registry unreachable

Required for `pnpm test:db` (testcontainer Postgres) and any local pgvector
spike: `docker pull postgres:16` and `docker pull pgvector/pgvector:pg16` both
fail with `403 Forbidden` against `production.cloudfront.docker.com` from inside
this sandbox container. No images cached locally either.

```
$ docker pull postgres:16
16: Pulling from library/postgres
unknown: failed to copy: httpReadSeeker: failed open: ... 403 Forbidden
```

**Consequence**:
- ❌ Cannot run `pnpm test:db` (testcontainer cannot start)
- ❌ Cannot spike-verify pgvector + Mem0 round-trip end-to-end here
- ❌ Pre-merge gate cannot reach green inside this sandbox session
- ✅ Unit tests with mocked DB/Mem0 still runnable

This is an **environment limitation of the launching sandbox**, not a project
issue. The brief's preflight ("Docker daemon running, pnpm test:db works")
inspected the daemon socket but not registry reachability. Master needs to
either run pre-merge gate in a different environment (host machine, CI) or
arrange a pre-pulled image cache.

### §3.3 DRIFT — `event.affected_scopes` column missing from schema

Brief §1.2 + driver §1.2 claim "`event.affected_scopes` text[] column ✅
already shipped". Reality:

```
$ grep -n "affected_scopes" src/db/schema.ts
# (no matches)
```

The column is not in `src/db/schema.ts`. ADR-0017 §"Schema additions" lists it
as "Drizzle generate + push" — never executed. Per brief instructions, this is
my call: **chose option (a) — add column + migration in this lane** because
deliverable 4 (`scope_tagger.ts`) writes to it. Will tag the commit as
"T-37 lane scope creep: add event.affected_scopes column per audit F-04 drift".

**Status**: accepted into this lane. Phase B adds the schema column, GIN index,
and write-path support because `scope_tagger` depends on this field.

---

## §4 What's installed / committed already in this lane

- `mem0ai@3.0.4` added to `package.json` dependencies
- `pnpm-lock.yaml` regenerated
- This spike-findings doc
- `src/server/memory/{client,brief,scope_tagger,triggers}.ts` implemented with
  mocked unit coverage
- `event.affected_scopes` schema column + GIN index landed in migration
- `memory_brief_note.latest_evidence_at` + `evidence_count` landed in migration
- `docker-compose.yml` Postgres image switched to `pgvector/pgvector:pg16`

### §4.1 Validation evidence from this lane

- `pnpm view mem0ai version` -> `3.0.4`
- Context7 `/mem0ai/mem0` docs confirm TypeScript `Memory` import from
  `mem0ai/oss`, pgvector config shape, and `add` / `search` option shape.
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test:unit` passed: 79 files / 675 tests.
- `pnpm test:db` passed with `pgvector/pgvector:pg16`: 125 files / 987 passed
  + 1 todo.
- `pnpm test:migration` passed: 10 migration-smoke tests, including vector
  extension + `event.affected_scopes` GIN index.
- `pnpm audit:schema` passed.
- `pnpm audit:partition` passed.
- `DATABASE_URL=postgres://loom:loom@127.0.0.1:5433/loom?sslmode=disable pnpm build`
  passed.

---

## §5 Decision matrix for master

| Question | Options | Lane subagent recommendation |
|---|---|---|
| **Q1**: Which embedder for Mem0? | A/B/C/D/E per §3.1 | **B** (OpenAI direct, `text-embedding-3-small`) for fastest PoC. Revisit later if Voyage / bge-m3 wins on Chinese recall — `Memory` config is rebindable. |
| **Q2**: Sandbox can't pull docker images. Continue 13pt impl with unit-test-only verification, deferring DB integration to a master-machine pre-merge run? | (i) continue here, defer green pre-merge; (ii) bail, master runs lane on a host with image cache | **(i) continue** — write impl + unit tests with Mem0 mocked + drizzle tests skipped; commit incrementally; master runs `pnpm test` on host. PR stays draft until host gate green. |
| **Q3**: Add `event.affected_scopes` schema column in this lane vs another? | (a) here; (b) escalate to separate PR | **(a) here** per driver §1.2 drift call-out. Deliverable 4 (`scope_tagger`) can't function otherwise. |
| **Q4**: ADR-0017 fix-up — embedder section explicitly says "Voyage / Anthropic", which is wrong. Update ADR? | yes/no | **Yes**, ADR-0017 should be amended ("Errata 2026-05-27: embedder choice deferred to lane spike; SDK supports openai/ollama/lmstudio/google/azure_openai/langchain only"). Light edit; out of T-37 critical path; can do as part of this PR or split. |

---

## §6 Risk update

| ADR-0017 risk | Spike verdict | Action |
|---|---|---|
| Mem0 OSS maturity | ✅ 3.0.4 GA, `Memory` class stable, `mem0ai/oss` submodule documented | Proceed; thin wrapper in `client.ts` preserves exit ladder |
| Chinese embedding quality | ⚠️ **not executed on this machine** — Q1 is answered as OpenAI `text-embedding-3-small`, but the runtime has no `OPENAI_API_KEY` to run the 34-event recall probe | Do not claim recall pass until a host with `OPENAI_API_KEY` runs the PoC recall probe; wrapper fails fast when the key is missing |
| Mem0 internal LLM bypass xiaomi | ✅ env-var swap works (§2.3) | Document in `client.ts` constructor: "Mutates process.env" |
| Anti-storm singletonKey ineffective | ✅ unit-tested: `enqueueBriefRegen` sends per-scope `singletonKey` + 360s window | DB-backed pg-boss behavior is delegated to pg-boss; lane verifies our enqueue contract |
| LLM cost overrun | not tested yet | unblock pending §3.2 |

---

## §7 Implementation update after master answers

1. Q1: default OpenAI embedder + `text-embedding-3-small` + `OPENAI_API_KEY`.
2. Q2: switch compose/testcontainers to `pgvector/pgvector:pg16`; any remaining
   Docker/key failure is a verification blocker, not a workaround trigger.
3. Q3: add `event.affected_scopes text[] default '{}' not null` in this lane.
4. Q4: amend ADR-0017 with the TS SDK embedder errata above.
