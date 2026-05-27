# T-37 Mem0 spike findings (Wave 1 worktree A lane subagent)

**Doc 日期**：2026-05-27
**Lane**：`lane/t37-brief-writer` (worktree A)
**Parent driver**：[docs/superpowers/plans/2026-05-27-t37-brief-writer-driver.md](2026-05-27-t37-brief-writer-driver.md)
**Status**：spike partial — embedder + sandbox blockers surfaced, escalating to master before further impl

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

**Recommendation pending master decision**: **B** (OpenAI direct) for PoC unless
master rejects the new API key dependency. **D** (ollama bge-m3) is best for
"zero external embedding dep" but adds NAS infra work outside T-37 scope.

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

**Status**: pending — blocked behind §3.1 + §3.2 decisions. If we agree to
proceed despite §3.2 (skip live DB tests), I'll still add the schema column +
drizzle migration so the deliverable 4 code can be reviewed even without
green DB tests.

---

## §4 What's installed / committed already in this lane

- `mem0ai@3.0.4` added to `package.json` dependencies
- `pnpm-lock.yaml` regenerated
- This spike-findings doc

**No code under `src/server/memory/` yet** — withheld pending master decision on
§3.1 embedder + §3.2 environment.

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
| Chinese embedding quality | ⚠️ **deferred** — depends on Q1 answer | Block deliverable 1 spike final verdict until master picks embedder |
| Mem0 internal LLM bypass xiaomi | ✅ env-var swap works (§2.3) | Document in `client.ts` constructor: "Mutates process.env" |
| Anti-storm singletonKey ineffective | not tested yet | unblock pending §3.2 — DB-backed pg-boss tests required |
| LLM cost overrun | not tested yet | unblock pending §3.2 |

---

## §7 Next steps awaiting master

1. Master answers Q1-Q4 above
2. If Q1=A (xiaomi OpenAI-protocol), master confirms / disproves xiaomi has `/v1/embeddings` endpoint
3. If proceed: lane subagent picks up:
   - Add `event.affected_scopes` column + migration
   - Add pgvector to `docker-compose.yml` (postgres image → `pgvector/pgvector:pg16`)
   - Add pgvector to `tests/global-setup.ts` (test image → same)
   - Write `src/server/memory/client.ts` + `brief.ts` + `scope_tagger.ts` + `triggers.ts` + 5 templates + anti-storm
   - Unit tests greenable here; DB integration tests left for master host run
4. If bail: master runs lane elsewhere with answers + cached docker images
