# YUK-253 — GLM-OCR engine swap (lane plan)

Branch: `yuk-253-glm-ocr-swap` · worktree `.claude/worktrees/yuk253-glm-ocr`
Linear: YUK-253 (impl decisions already locked in the issue comments — see §0)
Authored against fresh `main` (post-fetch 2026-06-07). Map facts cross-checked; conflicts in §9.

---

## 0. Scope & locked decisions (do not re-litigate)

Swap **only the OCR provider** inside the existing extraction job. The layered semantics
(OCR hint先行 → VLM `StructureTask` owns structure → VLM-fail → fallback to OCR structure)
are an owner invariant and **must not change**. Original-image storage invariant is untouched
(page images already live on `source_asset`; this lane never writes assets).

Locked in the YUK-253 issue:

1. New client `src/server/ingestion/glm_ocr.ts` — `layout_parsing` call (fetch, JSON + data URI).
2. New parser `glm_ocr_parser.ts` — `layout_details` blocks → OCR hint markdown + 块级 bbox.
   题级 bbox = `StructureTask` 切题后成员块 bbox 的并集 (analogue of Tencent `flat8ToBBox`,
   but GLM gives 4-number `[x1,y1,x2,y2]` absolute px instead of 8-number flat).
3. **Queue name `tencent_ocr_extract` does NOT change this lane.** Avoids collision with
   in-flight PR #329 (boss handlers region) + production in-queue job migration. Rename is a
   follow-up issue (§8).
4. Rollback flag `EXTRACT_OCR_ENGINE` env (`'glm'` default / `'tencent'` fallback). Tencent code
   kept one version-period with phase-deferred comments marking removal trigger.
5. cost_ledger: GLM `usage` × `0.2 元 / 1M tokens` (input+output同价). New billable point — the
   xiaomi endpoint never reports cost, but GLM does.
6. Tests: client unit (mock fetch: data URI / 1214 / timeout) + parser unit (real fixture) +
   handler test (existing tencent mock surface re-shaped) + golden fixtures into repo.
7. LaTeX habit: GLM uses `\frac` (Tencent `\dfrac`) — downstream is delimiter-agnostic; hint
   concat keeps content verbatim.

Hard engineering constraints: no new schema column (`audit:schema` bites); Biome; phase-deferred
comments on all retained-tencent / placeholder code; **tests never hit the live API** (all mocked);
`ZHIPU_API_KEY` lives in the main-repo `.env` only.

---

## 1. File-level change manifest

### CREATE
| Path | Purpose |
|---|---|
| `src/server/ingestion/glm_ocr.ts` | GLM `layout_parsing` client: `runGlmLayoutParsing()`, types, error normalization, timeout. Shape-aligned with `tencent_mark.ts`. |
| `src/server/ingestion/glm_ocr_parser.ts` | `parseGlmLayoutResponse()`: blocks→`{hintPages, figures, blocksByPage}` + `bboxUnion()` helper. Mirrors `tencent_mark_parser.ts` `ParseResult` shape (questions/figures/layout_quality/warnings) so the handler is a near drop-in. |
| `src/server/ingestion/glm_ocr.test.ts` | unit — mock `fetch`; data-URI assembly, 1214 error, timeout, usage passthrough. |
| `src/server/ingestion/glm_ocr_parser.test.ts` | unit — real fixtures; block→hint markdown, bbox normalization, bbox-union, image-block→figure. |
| `tests/fixtures/glm-ocr/math-page1.json` | from `/tmp/d8-glm-raw.json` (1-page math, 10 blocks incl. 2 image blocks). Golden. |
| `tests/fixtures/glm-ocr/yuwen-8page.json` | from `/tmp/d8-glm-real-yuwen-paper.json` (8-page 语文, per-page block arrays). Multi-page coverage. |
| `tests/fixtures/glm-ocr/tencent-math-page1.json` | from `/tmp/d7-tencent-raw.json` — 对照基准 (same page via Tencent), referenced by parser test for cross-engine sanity, not asserted byte-equal. |

### MODIFY
| Path | Change |
|---|---|
| `src/server/boss/handlers/tencent_ocr_extract.ts` | Engine置换 inside the per-page loop + cost_ledger numbers + new `submitGlmFn` dep + flag dispatch. **State machine calls unchanged** (§4). |
| `src/server/boss/handlers/tencent_ocr_extract.test.ts` | Re-shape mock surface from `submitFn/pollFn` (Tencent) to GLM mock dep; assert GLM cost numbers + flag both paths. |
| `src/core/schema/structured_question.ts` | Add `'glm_ocr'` to `StructuredQuestionSource` z.enum (Zod enum, **not** a DB column → no `audit:schema` impact). Parser stamps `source: 'glm_ocr'` on fallback-path questions. |
| `.env.example` | Add `ZHIPU_API_KEY=` + `EXTRACT_OCR_ENGINE=glm` block with inline docs (source, default, rollback semantics), beside the existing `TENCENT_*` block (lines 74-77). |
| `docs/deploy/real-ingestion-provisioning.md` | Add GLM-OCR credential row (`ZHIPU_API_KEY`, used-by `glm_ocr.ts`, lives in `.env`) + note `EXTRACT_OCR_ENGINE` default. |
| `vitest.shared.ts` | Add `glm_ocr.test.ts` + `glm_ocr_parser.test.ts` to `fastTestInclude` (unit partition — both are pure / fetch-mocked, no DB import). |

### DO NOT TOUCH (permanent dual-engine retention — owner 2026-06-07 拍板，不删)
- `src/server/ingestion/tencent_mark.ts`, `tencent_mark_parser.ts`, `tencent_mark_errors.ts` — kept verbatim as the `'tencent'` fallback engine behind the flag. Each carries a DUAL-ENGINE banner: permanently retained switchable engine (owner 2026-06-07), no removal planned.
- `tencent_mark.test.ts`, `tencent_mark_parser.test.ts` — kept (still exercise the retained tencent path).
- `src/server/boss/handlers.ts` — queue registration line unchanged (queue name frozen). The factory call may gain the new GLM dep injected the same lazy way as `r2`, but the `boss.work('tencent_ocr_extract', …)` string is **frozen**.
- `src/server/ingestion/structure.ts` (`renderTencentHint`, `runStructureTask`, `StructureResult`) — VLM layer is provider-agnostic; reused as-is. The GLM hint is rendered through the **same** `renderTencentHint`-shaped path (see §3).
- `src/server/ingestion/crop.ts`, `figure_attach.ts` — bbox is already 0-1 normalized `BBoxT`; GLM parser emits the identical shape, so figure crop/attach is untouched.

---

## 2. `glm_ocr.ts` client interface

```ts
// Endpoint + auth (locked domain fact)
//   POST https://open.bigmodel.cn/api/paas/v4/layout_parsing
//   Authorization: Bearer $ZHIPU_API_KEY
//   body: { model: 'glm-ocr', file: 'data:image/png;base64,<...>' }   // JSON ONLY; multipart → unsupported; bare base64 → 1214

export type GlmLayoutBlock = {
  index: number;
  label: string;            // 'text' | 'image' | ...
  native_label: string;     // 'doc_title' | 'paragraph_title' | 'header_image' | 'image' | ...
  bbox_2d: [number, number, number, number]; // ABSOLUTE px [x1,y1,x2,y2]
  // CRITIC-VERIFIED against /tmp/d8-glm-raw.json + d8-glm-real-yuwen-paper.json:
  // image-label blocks OMIT `content` entirely (key absent, NOT ''). Only text
  // blocks carry it. → MUST be optional, and every read site MUST guard for
  // undefined (e.g. `block.content?.trim() ?? ''`), never `block.content.xxx`.
  content?: string;         // markdown with $...$ LaTeX; ABSENT on image blocks
  width: number;            // page px width  (redundant w/ data_info)
  height: number;           // page px height
};

export type GlmLayoutResponse = {
  id: string;
  request_id: string;
  data_info: { num_pages: number; pages: Array<{ height: number; width: number }> };
  layout_details: GlmLayoutBlock[][];   // OUTER index = page, inner = blocks for that page
  md_results: string;                   // concatenated page markdown (advisory; not the source of truth)
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

export type GlmOcrParams = {
  /** raw page bytes; client builds the data URI. */
  imageBase64: string;
  mediaType: string;        // e.g. 'image/png' / 'image/jpeg' — drives the data: prefix
  signal?: AbortSignal;     // optional caller-supplied cancel
};

/** Submit one page to GLM layout_parsing and return the parsed JSON. */
export async function runGlmLayoutParsing(params: GlmOcrParams): Promise<GlmLayoutResponse>;
```

Behaviour:
- **Credential fail-fast** mirroring `createOcrClient()` (`tencent_mark.ts:17-24`): read & trim
  `process.env.ZHIPU_API_KEY`; throw a clear `Error('GLM OCR client requires ZHIPU_API_KEY')`
  before any fetch. (PermanentError-classifiable; see error norm below.)
- **data URI assembly**: `file: \`data:${mediaType};base64,${imageBase64}\``. JSON body only —
  `Content-Type: application/json`. (Multipart and bare base64 are both rejected by GLM — domain fact.)
- **Timeout**: single fetch with `AbortController`, default `timeoutMs = 120_000` (one-shot, unlike
  Tencent's submit+poll loop — GLM `layout_parsing` is synchronous). Timeout → `RetryableError`
  (`Tencent` parity: poll timeout was Retryable, so pg-boss retries).
- **Error normalization** → a small `mapGlmError()` (inline in client, or a sibling
  `glm_ocr_errors.ts` if it grows; start inline):
  - HTTP 401/403 or missing key → `PermanentError` (auth/arrears never self-heal).
  - GLM error code `1214` (格式错误 / bad data URI) → `PermanentError`.
  - HTTP 429 / 5xx / network / abort-timeout → `RetryableError`.
  - 2xx but body missing `layout_details` → `PermanentError('GLM returned no layout_details')`.
  Reuse the existing `RetryableError`/`PermanentError` from
  `@/core/schema/structured_question` so the handler's `markFailedAndLogCost` classification
  (`tencent_ocr_extract.ts:373-375`) keeps working **without change** — it already accepts any
  thrown `Retryable|Permanent` directly and only routes unknown errors through `mapTencentError`.
  GLM client throws typed errors, so `mapTencentError` is never reached on the GLM path.

Shape-alignment to `tencent_mark.ts`: same module conventions (env fail-fast helper, typed
params, typed response, thrown `Retryable/PermanentError`). The submit+poll **pair** collapses to a
**single** `runGlmLayoutParsing` — the handler dep surface changes from `{submitFn, pollFn}` to
`{glmOcrFn}` (§4).

---

## 3. `glm_ocr_parser.ts` design

Goal: produce the **same downstream contract** the handler already consumes from Tencent, so the
VLM layer + fallback + figure pipeline are untouched.

```ts
export type GlmParsedPage = {
  page_index: number;
  hintMarkdown: string;                 // page blocks' content, in reading order
  blocks: Array<{ index: number; bbox: BBoxT; label: string; content: string }>;
  figures: ParsedFigureBox[];           // image-label blocks → {bbox, source_page_index}
};

export type GlmParseResult = {
  pages: GlmParsedPage[];
  layout_quality: LayoutQuality;        // reuse type from tencent_mark_parser
  warnings: string[];
};

export function parseGlmLayoutResponse(
  resp: GlmLayoutResponse,
  pageIndexBase = 0,
): GlmParseResult;

/** [x1,y1,x2,y2] absolute px → 0-1 normalized BBoxT (GLM analogue of flat8ToBBox). */
export function glmBBox(b: [number, number, number, number], w: number, h: number): BBoxT;

/** Union of member-block bboxes → one enclosing BBoxT (for 题级 bbox post-split). */
export function bboxUnion(boxes: BBoxT[]): BBoxT;
```

Mapping rules:
- Page dims from `data_info.pages[pageIndex]` (authoritative) — block `width`/`height` are redundant.
- **hint markdown**: join each page's non-image block `content` in `index` order with `\n\n`.
  **Guard `content` for `undefined`** — image blocks have no `content` key (critic-verified);
  filter to `label !== 'image'` AND `typeof content === 'string'` before joining. Keep LaTeX
  verbatim (`\frac` etc.). This is the GLM analogue of the per-page Tencent structure; it is fed to
  the VLM as advisory text. (Optionally fall back to `md_results` if present and blocks are empty —
  but blocks are the structured source.)
- **figures**: blocks whose `label === 'image'` (covers `native_label` `header_image` / `image`)
  → `{ bbox: glmBBox(bbox_2d,...), source_page_index }`. These feed the **unchanged**
  `cropAndUploadFigures` (it takes `BBoxT[]`).
- **题级 bbox (the locked decision #2)**: the parser does **not** itself split into questions —
  the VLM `StructureTask` owns splitting. After the VLM returns the structure tree, the handler
  maps each top-level question back to its constituent GLM text blocks (by reading-order / content
  containment) and takes `bboxUnion(memberBlockBboxes)`. **However**, current `applyExtractionResult`
  `page_spans` use a full-page `{0,0,1,1}` bbox (ADR-0002 — handler lines 308-314), so 题级 bbox is
  **not consumed by the block model today**. → Keep the parser's per-block bbox available and add
  `bboxUnion`, but **do not** wire 题级 bbox into `page_spans` this lane (it would change
  `applyExtractionResult` semantics — out of scope). Mark `bboxUnion` + block bbox retention with a
  phase-deferred comment: "题级 bbox 并集 ready for when page_spans drops full-page bbox; see YUK-253".
  This keeps the locked decision's machinery in place without violating the "structure semantics不动"
  invariant. **(See §9 conflict note — this is the one place the locked spec and current code diverge.)**

Fallback structure path (VLM fails — analogue of the Tencent fallback):
- The Tencent fallback builds `tencentFallbackQuestions` from `parseMarkAgentResponse` questions
  (full nested stem/sub tree). GLM's parser does **not** produce a question tree (no MarkAgent
  splitting). So the GLM fallback degrades to **one `standalone` `StructuredQuestionT` per page**,
  built from the page's `hintMarkdown` as `prompt_text`, `source: 'glm_ocr'`, `page_index` set,
  `bbox` = page-level union (or omitted). `layout_quality`:
  - `'structured'` if every page has ≥1 text block,
  - `'text_only'` if a page yielded only image/empty blocks,
  - `'partial'` otherwise.
  This guarantees extraction never hard-fails on a VLM outage (regression-safety parity with the
  Tencent fallback) while being honest that GLM-without-VLM has no real splitting. Document this
  degradation explicitly in a comment + a `warnings.push('GLM fallback: page-level standalone, no sub-question split')`.

`source` field: fallback-path questions get `source: 'glm_ocr'` (new enum member). VLM-path
questions keep `source: 'vlm_structure'` (unchanged — the VLM owns them regardless of OCR engine).

---

## 4. Handler置换 — precise diff range

File `src/server/boss/handlers/tencent_ocr_extract.ts`. **All `Ingestion.*` state-machine calls stay
byte-identical** (`markExtractionStarted` :124, `applyExtractionResult` :324-332,
`markExtractionFailed` :379, `writeCostLedger` :335-344 & :388-397 — only the numeric fields change).

| Lines | Current | Change |
|---|---|---|
| 20-26 (imports) | `tencent_mark` submit/poll + `parseMarkAgentResponse` | + import `runGlmLayoutParsing`, `parseGlmLayoutResponse` from `glm_ocr*`. Keep tencent imports (fallback engine). |
| 52-64 (`TencentOcrDeps`) | `submitFn?`, `pollFn?`, `runStructureFn?` | add `glmOcrFn?: typeof runGlmLayoutParsing`. Keep `submitFn/pollFn` for the retained tencent path. |
| 81-83 (fn resolution) | `submit/poll/runStructure` defaults | add `const glmOcr = deps.glmOcrFn ?? runGlmLayoutParsing;` + read engine: `const engine = process.env.EXTRACT_OCR_ENGINE ?? 'glm';` |
| 135-195 (per-page loop) | download→sharp dims→`submit`→`poll`→`parseMarkAgentResponse`→`cropAndUploadFigures` | branch on `engine`. GLM branch: download→(sharp dims still needed for crop)→`runGlmLayoutParsing({imageBase64, mediaType})`→`parseGlmLayoutResponse`→push `hintPages` + figures. Tencent branch: existing code verbatim. Both branches converge on the same `pageImages` / `tencentPages`(rename → `ocrHintPages`)/`allPreFigures` accumulators so §10+ is engine-agnostic. |
| 209 (`renderTencentHint`) | renders Tencent per-page questions | GLM path renders its own per-page `hintMarkdown` (already markdown) — either reuse `renderTencentHint` by wrapping GLM pages as `{page_index, questions:[standalone(hintMarkdown)]}`, **or** add a thin `renderGlmHint(pages)` that joins `=== page K ===` + hintMarkdown. Prefer the thin renderer to avoid synthesizing fake questions; it lives in `glm_ocr_parser.ts`. |
| 210 (`tencentFallbackQuestions`) | flat tencent questions | GLM path: page-level standalone questions from §3 fallback. |
| 225-250 (VLM call + fallback) | unchanged logic | unchanged — `runStructure` is engine-agnostic; only the `tencentHintMd` source and `*FallbackQuestions` source differ (computed above). |
| 296-318 (block build / page_spans) | unchanged | unchanged — full-page bbox retained (ADR-0002). |
| 335-344 (success cost_ledger) | provider `'tencent'`, model `'QuestionMarkAgent'`, cost 0, tokens 0 | GLM path: provider `'glm'`, model `'glm-ocr'`, `cost`/`tokens_in`/`tokens_out` from accumulated `usage` (§5). Tencent path keeps 0/0/0. |
| 367-401 (`markFailedAndLogCost`) | provider `'tencent'` | parametrize provider/model by engine; cost 0 on failure (no successful tokens billed). Classification path unchanged (typed errors). |
| 50 (`TASK_KIND`) | `'tencent_ocr_extract'` | **unchanged** (queue + ledger task_kind frozen). |

Renames inside the handler (local vars only, no external contract): `tencentPages` → `ocrHintPages`,
`tencentLayout` → `ocrLayout`, `tencentFallbackQuestions` → `ocrFallbackQuestions`. Pure cosmetic;
keeps the file readable post-swap. (Optional — can defer if reviewer prefers minimal diff.)

---

## 5. Accounting

Single success-path `writeCostLedger` (handler :335). GLM is the **first** billable OCR point.

- Accumulate per-page `usage.total_tokens` (and split prompt/completion) across the page loop into
  `let glmPromptTokens = 0, glmCompletionTokens = 0`.
- On success: `tokens_in = glmPromptTokens`, `tokens_out = glmCompletionTokens`,
  `cost = (glmPromptTokens + glmCompletionTokens) / 1_000_000 * 0.2`. (0.2 元/M, input=output price.)
  - Note unit: existing `cost_ledger.cost` is a `real` historically used as USD for AI tasks, but
    Tencent writes 0 so unit was never load-bearing for OCR. GLM cost is in **RMB 元**. Document
    the unit in a comment at the write site (`// cost in RMB 元 — GLM OCR 0.2元/M tokens`) and in the
    parser/ledger note. If a single currency column is a concern, raise as a follow-up (§8) — do
    **not** add a column this lane (`audit:schema`).
- Failure path: `cost = 0`, tokens 0 (no completed billable run), `outcome` from error class.
- `provider = 'glm'`, `model = 'glm-ocr'`, `task_kind = 'tencent_ocr_extract'` (frozen),
  `pgboss_job_id = bossJobId`. No `ai_task_runs` row (external API, not Claude Agent SDK — same as
  Tencent; confirmed by Map ledger-env facts).

---

## 6. Test plan

| File | Partition | Key assertions | Fixture |
|---|---|---|---|
| `src/server/ingestion/glm_ocr.test.ts` | **unit** (`vi.mock` global `fetch`) | (a) data URI assembled `data:image/png;base64,…` + JSON content-type + bearer header; (b) `ZHIPU_API_KEY` missing → throws before fetch; (c) GLM `1214` body → `PermanentError`; (d) 429/5xx → `RetryableError`; (e) abort/timeout → `RetryableError`; (f) happy path returns parsed `usage`. | inline + `math-page1.json` body |
| `src/server/ingestion/glm_ocr_parser.test.ts` | **unit** (pure) | (a) blocks→hint markdown in index order, LaTeX verbatim; (b) `glmBBox` normalization vs page dims; (c) `image` blocks→figures with correct normalized bbox; (d) `bboxUnion` encloses members; (e) multi-page (8-page yuwen) page_index stamping; (f) `layout_quality` heuristic (text_only when page has only image blocks); **(g) CRITIC-ADDED: image blocks (no `content` key) are skipped in hint-join without throwing — `math-page1.json` has 2 such blocks (idx 0/9), yuwen has 8; assert hint omits them and no `undefined`/throw.** | `math-page1.json`, `yuwen-8page.json` |
| `src/server/boss/handlers/tencent_ocr_extract.test.ts` | **db** (real PG, injected mocks) | Re-shape: replace `submitFn/pollFn` stubs with `glmOcrFn` stub returning a `GlmLayoutResponse`. Assert: (a) happy VLM path → blocks + cost_ledger row `provider='glm'`, `model='glm-ocr'`, `cost≈tokens*0.2/M`, `tokens_in/out` set; (b) VLM-fail → GLM page-level fallback questions, ledger still written; (c) GLM client throws Permanent → `markExtractionFailed` + `failed_permanent` ledger; (d) `EXTRACT_OCR_ENGINE='tencent'` flag → falls through to the retained tencent mocks (keep ≥1 tencent-path test alive). | reuse fixtures + injected stub |
| (retained) `tencent_mark*.test.ts` | unit | unchanged — guards the retained fallback engine. | existing |

Fixture provenance: copy `/tmp/d8-glm-raw.json` → `tests/fixtures/glm-ocr/math-page1.json`,
`/tmp/d8-glm-real-yuwen-paper.json` → `yuwen-8page.json`, `/tmp/d7-tencent-raw.json` →
`tencent-math-page1.json`. Trim only if a fixture exceeds ~50KB and the trimmed blocks are
unreferenced (yuwen is 46KB — keep whole; it's the multi-page coverage). Import via relative path
`../../../tests/fixtures/glm-ocr/…` (matches `tencent_mark_parser.test.ts:2` convention).

Partition guard: both new unit tests must **not** import `@/db/client` / `postgres` / `drizzle` /
`PgBoss`; the client test mocks `fetch` (global), the parser test is pure. Add both to
`fastTestInclude`; run `pnpm audit:partition` to confirm.

---

## 7. Commit切分 (atomic, last = Closes)

1. **`feat(ingestion): GLM-OCR layout_parsing client + parser (Refs YUK-253)`**
   `glm_ocr.ts`, `glm_ocr_parser.ts`, `glm_ocr.test.ts`, `glm_ocr_parser.test.ts`,
   `tests/fixtures/glm-ocr/*`, `vitest.shared.ts`, `structured_question.ts` (+`glm_ocr` enum).
   Self-contained, no handler wiring → green unit tests on its own.

2. **`feat(ingestion): swap extraction engine to GLM behind EXTRACT_OCR_ENGINE flag (Closes YUK-253)`**
   `tencent_ocr_extract.ts` (engine branch + GLM cost_ledger), `tencent_ocr_extract.test.ts`
   (re-shaped mock surface + flag both paths), `.env.example`, `real-ingestion-provisioning.md`,
   phase-deferred banners on retained `tencent_mark*.ts`.
   Last commit carries `Closes YUK-253` + `Co-Authored-By` trailer.

(If reviewer wants the docs/env split out: optional commit 3 `docs(deploy): GLM-OCR env + provisioning`.
Default to 2 commits.)

---

## 8. Follow-up Linear issues (capture gate)

- **Queue rename** `tencent_ocr_extract` → `ocr_extract` (provider-neutral) once GLM is baked in
  and PR #329 has merged — requires an in-queue job migration plan. (NEW issue — file at impl time.)
- **Remove retained Tencent engine** + `EXTRACT_OCR_ENGINE` flag after bake-in window (the
  phase-deferred removal trigger). (NEW issue.)
- **cost_ledger currency unit**: column carries mixed USD (AI tasks) + RMB (GLM OCR). Decide a single
  unit or add a `currency` discriminator. (NEW issue — explicitly NOT this lane; `audit:schema`.)
- **题级 bbox into page_spans**: when ADR-0002's full-page-bbox constraint is relaxed, wire
  `bboxUnion` into `page_spans`. (NEW issue — machinery is staged in the parser.)

---

## 9. Risk / cross-PR collision review

**In-flight PR file intersection (post-`git fetch` 2026-06-07):**
- **PR #332** (`pdf-docx-ingest`, YUK-250): touches `vitest.shared.ts` (+5 lines, adds pdf fixtures)
  and `tests/fixtures/pdf/*`. **Collision: `vitest.shared.ts`** — both add to `fastTestInclude`.
  Trivial textual conflict (different lines); resolve by appending GLM entries after PR #332's pdf
  entries at merge. No semantic overlap — pdf path renders page images upstream of extraction; GLM
  swap is downstream. **Low risk.**
- **PR #329** (`audit-20260606-fixes`): touches `src/server/boss/handlers.ts` and
  `src/server/ingestion/tencent_mark.test.ts` and `vitest.{shared,db,migration,config}.ts`.
  **Collision: `handlers.ts`** (this lane leaves the queue line frozen but may inject a GLM dep into
  the factory call) and **`tencent_mark.test.ts`** (#329 edits it; this lane retains it untouched —
  so no conflict from our side, but rebase after #329). **The queue-name freeze decision (#3) exists
  specifically to avoid the boss region conflict with #329.** Medium risk on `handlers.ts` factory
  call — mitigate by injecting the GLM dep with the same lazy-getter pattern as `r2`, minimal lines.
  **Rebase order: land after #329 if possible.**
- **PR #328** (`yuk-164-oc5-review-surface`): `VisionTab.tsx`, ingestion route/blocks, UI. **No
  intersection** with this lane's files. **No risk.**
- **PR #330** (drift report): docs only. **No risk.**

**Production deployment env dependency (must go in PR body):**
- NAS `.env` (compose-injected) must gain `ZHIPU_API_KEY` before deploy, else GLM path fail-fasts
  with `PermanentError` and every extraction fails-permanent. `EXTRACT_OCR_ENGINE` defaults to
  `'glm'` — so **deploying this without the key set bricks ingestion**. PR body must call out:
  set `ZHIPU_API_KEY` in NAS `.env` AND (optionally) `EXTRACT_OCR_ENGINE=tencent` as a pre-key
  safety until the key lands. `TENCENT_*` keys must remain set during the bake-in window (fallback).

**Conflict between locked spec and current code (the one real divergence):**
- Locked decision #2 says "题级 bbox = StructureTask 切题后成员块 bbox 并集". But the current
  `applyExtractionResult` writes **full-page** `{0,0,1,1}` `page_spans` bbox (ADR-0002, handler
  lines 308-314) and never consumes a per-question bbox. Wiring 题级 bbox into `page_spans` would
  change block-model semantics — which the same brief forbids ("分层语义不许动" / "structure
  semantics不动"). **Resolution (recorded here for the impl agent):** build & unit-test `bboxUnion`
  + retain per-block bbox in the parser (so the machinery the locked decision asks for exists), but
  do **not** wire it into `page_spans` this lane; stage it behind a phase-deferred comment + a
  follow-up issue (§8). This honors both constraints. Flag to the user at PR time.

---

## 10. Gate (pre-PR)

`pnpm typecheck` · `pnpm lint` · `pnpm audit:schema` · `pnpm audit:partition` · `pnpm audit:profile`
· `pnpm test` · `pnpm build` (with `DATABASE_URL` placeholder). Tests never hit live GLM API.

---

## 11. Critic 修正记录 (2026-06-07, verdict FINAL)

Reviewed against fresh `main` code + Map facts + the three real fixtures (`/tmp/d8-glm-raw.json`,
`/tmp/d8-glm-real-yuwen-paper.json`, `/tmp/d7-tencent-raw.json`). Handler line-number claims
(§4: 124/209/210/296-318/324-332/335-344/367-401/50) all verified byte-accurate against
`tencent_ocr_extract.ts`. Cross-PR collisions (§9: #332 `vitest.shared.ts`, #329 `handlers.ts`
+ `tencent_mark.test.ts` + four `vitest.*.ts`, #328/#330 no-intersection) verified against live
`gh pr list --files`. Layering invariant (OCR-hint→VLM-owns-structure→VLM-fail-fallback) preserved:
GLM swaps only the per-page OCR engine; `runStructureTask` / `renderTencentHint` / fallback path /
`applyExtractionResult` full-page-bbox semantics all untouched. Reuse of typed `Retryable/Permanent`
errors keeps `markFailedAndLogCost` classification (handler:373-374) working unchanged — verified.
No over-engineering: queue-name freeze, no rename, no DOCX line, 题级 bbox staged-not-wired — all
correctly scoped down.

**P2 fixes applied (verdict held FINAL — these are correctness sharpenings, not blockers):**

1. **`GlmLayoutBlock.content` was typed `content: string` ("'' for image blocks") — WRONG.**
   Both real fixtures prove image-label blocks **omit the `content` key entirely** (math-page1:
   idx 0 + 9; yuwen: 8 image blocks all keyless). A non-defensive `block.content.trim()` on an
   image block would throw `TypeError`. Fixed §2 type → `content?: string` with a guard banner;
   fixed §3 hint-join rule to filter `label !== 'image' && typeof content === 'string'`; added §6
   parser-test assertion (g) covering the keyless-image-block case against the real fixtures.

**Confirmed-correct (no change needed), recorded so impl doesn't re-litigate:**

- `BBoxT` = `{x,y,width,height}` all 0-1 normalized with `x+width<=1` / `y+height<=1` refines
  → `glmBBox([x1,y1,x2,y2],w,h)` must emit `{x:x1/w, y:y1/h, width:(x2-x1)/w, height:(y2-y1)/h}`;
  cannot reuse `flat8ToBBox` (hard-asserts exactly 8 numbers, parser:39-41). ✓ as planned.
- `cropAndUploadFigures` consumes `figureBoxes: BBoxT[]` (normalized) → parser figures must carry
  `.bbox: BBoxT`; handler feeds `parsed.figures.map(f=>f.bbox)` unchanged. ✓ figure pipeline untouched.
- `RetryableError`/`PermanentError` are exported from `@/core/schema/structured_question`
  (lines 193/200) — reuse is valid. ✓
- `StructuredQuestionSource` z.enum (schema lines 73-82) is a Zod enum, **not** a DB column → adding
  `'glm_ocr'` does not trip `audit:schema`. ✓
- `RunStructureTaskParams.tencentHintMd` is a plain `string` (structure.ts:253) → a thin
  `renderGlmHint(pages): string` feeds it cleanly; no need to synthesize fake questions or wrap GLM
  pages in `TencentPageHint`. Prefer the thin renderer (§4 line 220 already says so). ✓
- `usage` shape `{prompt_tokens, completion_tokens, total_tokens}` confirmed in fixture
  (1128/440/1568) → cost-accounting plan §5 is grounded. ✓
- No pre-existing `glm`/`ZHIPU`/`bigmodel`/`layout_parsing` refs in `src/`/`app/`/`tests/` → clean add. ✓
- `.env.example` Tencent block at lines 74-77 (matches §1). `fastTestInclude` tencent entries at
  vitest.shared.ts:91-92 (matches §1). ✓

**Verdict: FINAL.** Plan is exhaustive, layering-faithful, correctly scoped, collision-aware. The
one factual type error is fixed in-doc. Impl agent should treat §11 as binding alongside §1-§10.
