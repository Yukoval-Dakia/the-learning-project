# YUK-145 T-OC Slice 2 — VLM StructureTask (the structure owner) — Lane Plan

> Written fresh against `main @ 955a787f` (slice 1 already merged) in worktree
> `/private/tmp/tlp-yuk145-toc2` on branch `yuk-145-toc-slice2`. Authority: the
> design-approved spec `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md`
> (OC-1/OC-2) + slice-1 lane plan `2026-05-30-yuk145-toc-slice1-lane.md`
> §DEFERRED ("Slice 2 — StructureTask"). This lane implements **OC-1 + OC-2**:
> Tencent demoted to text-only hint; VLM owns structure.

## 1. Problem (spec §1, §2 OC-1/OC-2)

Today `src/server/boss/handlers/tencent_ocr_extract.ts` makes **Tencent the
structure owner**: `parseMarkAgentResponse` builds the `StructuredQuestion[]`
tree and `assignFigures` (a bbox heuristic) decides which figure belongs to
which question. Two hard failures the spec calls out:

- **跨页大题** (a question split across pages): the handler only reads
  `session.source_asset_ids[0]` with `pageIndex: 0` — it is **single-page** and
  cannot assemble a 大题 that spans pages (YUK-144).
- **题图匹配** is the easily-wrong `assignFigures` bbox containment / nearest-
  centroid heuristic.

OC-1/OC-2 lock the direction: Tencent stays the **character-level text OCR**
(it's accurate), but its **structure output is demoted to a text hint**; a new
**VLM StructureTask (multimodal mimo-v2.5)** owns the normalized structure —
sees all N page images + the Tencent text hint, and assembles the cross-page
tree.

## 2. Locked decisions consumed

- **OC-1**: Tencent → text-only OCR底层; its structure output is a hint, not
  source of truth.
- **OC-2**: StructureTask (VLM mimo-v2.5 multimodal) 全权重写结构: 跨页大题组装 +
  布局规范, can fully override Tencent structure.

## 3. Key plumbing facts that make this reuse, not reinvent

- The runner's multimodal path (`src/server/ai/runner.ts`
  `multimodalPromptIterable`) already sends **N images in one user message**
  (text + base64 image blocks). Multi-image VLM input is a solved capability —
  `runStepsJudge` (`src/server/ai/judges/steps-judge.ts`) is the live precedent:
  an **auto-invoked** multimodal task that passes `{ text, images: [...] }`
  through `runTask`, parses strict JSON via a Zod schema, and injects
  `runTaskFn` + `imageFetchFn` for testability. **No provider-capability
  blocker** — confirmed in pre-flight.
- `parseMarkAgentResponse` (`tencent_mark_parser.ts`) already returns BOTH
  `questions` (structure — to be DEMOTED to a text hint) AND `figures` (bbox
  list — still consumed for crop). We keep calling it; we just stop trusting its
  `questions` as the structure of record, and feed a flattened text rendering of
  them to the VLM as the hint.
- `Ingestion.applyExtractionResult` (`src/server/session/ingestion.ts`) takes
  `blocks: { structured, figures, page_spans, source_asset_ids, image_refs }`.
  The VLM's normalized tree drops straight into `structured` — same write path,
  no schema change.

## 4. Build order (files create-vs-modify)

1. **MODIFY** `src/ai/registry.ts` — register `StructureTask`
   (`defaultProvider:'xiaomi'`, `defaultModel:'mimo-v2.5'` multimodal,
   `isMultimodal:true`, `maxIterations:1`, longer timeout for multi-page,
   `invocation:'auto'` — it runs as part of extraction, like `StepsJudgeTask`).
2. **MODIFY** `src/ai/task-prompts.ts` — add `buildStructurePrompt(profile)` +
   wire the `case 'StructureTask'` in `getTaskSystemPrompt`. Prompt: input =
   page images (in message order) + Tencent text hint; output = strict JSON
   normalized question tree (stem/sub/standalone), 跨页大题 assembled into one
   stem, layout normalized. **Figure↔question association is OUT (slice 2b)** —
   the prompt does not ask the VLM to emit `attached_to_index`.
3. **CREATE** `src/server/ingestion/structure.ts` — `runStructureTask(params)`:
   - input: `{ db, pageImageRefs: string[], tencentHintMd: string, runTaskFn?,
     imageFetchFn?, subjectProfile? }`.
   - fetches page images via injectable `imageFetchFn` (default = the same R2
     base64 fetch `steps-judge.ts` uses, factored to a shared helper or
     re-implemented locally — see §7).
   - calls `runTaskFn('StructureTask', { text, images }, ctx)`.
   - parses strict JSON via a new `StructureOutput` Zod schema → returns
     `{ questions: StructuredQuestionT[]; layout_quality; warnings }` shaped to
     match what `applyExtractionResult` needs.
   - each returned question gets `source: 'vlm_structure'` (new enum value, §6).
   - on VLM failure / empty / unparseable → throws a typed error so the handler
     can fall back to the Tencent structure (regression safety — §5).
4. **CREATE** `src/server/ingestion/structure.test.ts` — unit tests (no DB, no
   real LLM): injected `runTaskFn` returning canned VLM JSON →
   - happy path: 2-page 跨页大题 assembled into one stem with subs.
   - strict-JSON parse + Zod validation (reject malformed).
   - empty/zero-question output → throws (handler falls back).
   - the Tencent hint text rendering is correct (flatten helper).
5. **MODIFY** `src/server/boss/handlers/tencent_ocr_extract.ts`:
   - load **all** session assets (not just `[0]`) → page buffers + dims, in page
     order. (cross-page: VLM sees every page.)
   - submit Tencent OCR **per page** (Tencent endpoint is single-image); collect
     each page's `parseMarkAgentResponse` result. Tencent figures (bboxes) are
     still cropped per page (`cropAndUploadFigures`).
   - build the **Tencent text hint** = flattened markdown of all pages' parsed
     `questions` (via `structuredToPromptMarkdown` per top-level q, prefixed with
     `=== page N ===`).
   - call `runStructureTask` with all page image refs + the hint. VLM tree
     becomes the structure of record.
   - **fallback**: if `runStructureTask` throws (VLM down / unparseable), fall
     back to the **per-page concatenated Tencent structure** (current behaviour)
     so extraction never hard-fails because the VLM is unavailable —
     evidence-first + regression safety. A warning is appended.
   - figures: keep `cropAndUploadFigures` + **`assignFigures`** (slice 2b will
     replace this with VLM matching). `assignFigures` runs against the VLM tree
     (its questions have ids); for cross-page figures the heuristic attaches by
     bbox within the page's questions.
   - `applyExtractionResult` is called once with the assembled blocks +
     `layout_quality` from the VLM (or fallback).
   - add injectable `runStructureFn?` to `TencentOcrDeps` (mirrors `submitFn`/
     `pollFn`) so the handler test can stub the VLM.
6. **MODIFY** `src/server/boss/handlers/tencent_ocr_extract.test.ts` — keep all
   existing regression cases green (default-injected stub `runStructureFn`
   returns a VLM tree; the FAIL / R2-missing / session-missing cases unchanged).
   Add: VLM-structure path produces blocks with `source:'vlm_structure'`; VLM
   failure → Tencent fallback still produces blocks + a warning.
7. **MODIFY** `src/core/schema/structured_question.ts` — add `'vlm_structure'`
   to `StructuredQuestionSource` enum (and the `StructuredQuestionT.source`
   union). Pure enum widen; no migration (it's a jsonb value, not a column).
8. **MODIFY** `docs/adr/0002-...md` — flip the 2026-05-30 revision section from
   "Direction/FUTURE (slice 2)" to "implemented (slice 2)" with the actual
   design (VLM authority, Tencent→text-hint, **figure-matching DEFERRED to 2b**).

## 5. Regression safety (spec §9 last bullet)

- Tencent text OCR + R2 assets + SSE progress (`job_events` via
  `applyExtractionResult` / `markExtraction*`) untouched — same call sites.
- The slice-1 generalized `enrollCapturedBlock` import path is **downstream** of
  extraction and is not touched: it still consumes `question_block.structured`
  via the import route exactly as before.
- VLM-down fallback to Tencent structure means a provider outage degrades to
  slice-1 behaviour rather than hard-failing extraction.

## 6. Schema / audit (conventions)

- New `StructuredQuestionSource` value `'vlm_structure'` is a **jsonb enum
  value**, not a DB column → no migration, no `audit:schema` allowlist entry
  (the `question_block.structured` / `question.structured` columns already have
  write paths from slice 0c/M-1).
- No new business columns. `pnpm audit:schema` must stay green with no new
  allowlist entry.

## 7. YAGNI / reuse calls

- Image fetch: `steps-judge.ts defaultImageFetch` is private to that module. I
  re-use the **pattern** (R2 get + base64) inside `structure.ts` rather than
  exporting/refactoring it — a second concrete instance, but factoring a shared
  helper for 2 call sites with slightly different shapes is premature (the
  handler already has page buffers in hand; `structure.ts` accepts already-
  fetched base64 OR an `imageFetchFn`). Keep it local + injectable.
- The handler already downloads page buffers for Tencent + sharp dims; it passes
  those same base64 buffers to `runStructureTask` (no double R2 fetch in prod).

## 8. Definition of done

`pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`,
`pnpm audit:profile`, `pnpm test`, `DATABASE_URL=postgres://x INTERNAL_TOKEN=x
pnpm build` — all green (Docker up). Commit on `yuk-145-toc-slice2` with
`Refs YUK-145` (slice 2 of N, NOT Closes).

---

## DEFERRED — NOT built in this lane

### Slice 2b — VLM figure↔question matching (replacing `assignFigures`)
The spec's OC-2 题图匹配 (VLM decides which figure belongs to which question,
replacing the `assignFigures` bbox heuristic). DEFERRED because it couples the
VLM-generated question-id namespace to the crop/bbox namespace: the VLM would
need to emit per-figure `attached_to_index` referencing question ids it itself
generated, threaded back through `cropAndUploadFigures` (which still needs
Tencent bboxes — the VLM can't reliably emit pixel bboxes). That coupling is the
fragile part; a half-working version risks mis-attached figures with no easy
audit. Slice 2 keeps `assignFigures` (Tencent bbox heuristic) for figure↔
question association; the StructureTask prompt is written so 2b is a clean
extension (add a `figures` block to the output schema + thread ids).
**Seam:** `src/server/boss/handlers/tencent_ocr_extract.ts` keeps the
`assignFigures(...)` call with a comment pointing here.

### Slice 3 — TaggingTask + WorkflowJudge + auto-enroll review surface (OC-4/OC-5)
Unchanged from slice-1 lane plan §DEFERRED: TaggingTask (auto knowledge_ids),
WorkflowJudge (confidence gate → auto-enroll vs review), "AI auto-enrolled N"
review surface. The slice-1 `generated_by` provenance seam in `enroll.ts` is
where WorkflowJudge plugs in.
