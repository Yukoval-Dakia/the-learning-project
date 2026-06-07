# YUK-250 — PDF Ingest Lane Implementation Plan

**Branch**: `pdf-docx-ingest`
**Scope**: PDF half only. DOCX is explicitly **descoped** here (see §0 / §8). Closes YUK-250.
**Date**: 2026-06-06
**Author**: PDF lane planner

---

## 0. Scope decision (read first)

The branch name promises `pdf-docx-ingest`, but the Map's renderer research is unambiguous: there is **no clean-license, zero-system-dependency, pure-WASM DOCX→image renderer** equivalent to what exists for PDF. Free DOCX→raster in Node realistically requires LibreOffice/`soffice` (a system dependency that violates the "container zero system deps" constraint) or a paid SDK/cloud (Apryse/Nutrient/ConvertAPI).

**This plan ships PDF only.** DOCX is split into a separate Linear follow-up (YUK to be filed at lane close) with three candidate paths recorded for a later decision:
- (a) accept a LibreOffice sidecar container in `docker-compose.yml`;
- (b) client-side / preprocess DOCX→PDF before upload;
- (c) descope DOCX permanently.

Do **not** silently bundle LibreOffice into the app container. Surface this to the user at lane close.

---

## 1. Seam location — where a PDF expands into page images

### Decision: dedicated `POST /api/ingestion/pdf` expansion endpoint (NOT the `/api/assets` route)

**Two options evaluated:**

| Option | Mechanism | Verdict |
|---|---|---|
| **A. `/api/assets` accepts `application/pdf` and renders inline, returning N page assets** | Add `application/pdf` to `ALLOWED_MIME`, branch on mime in `POST /api/assets`, render → loop `r2.put` → return an array of asset rows | **Reject** |
| **B. dedicated `POST /api/ingestion/pdf` expansion endpoint** | New route takes one PDF multipart upload, renders to N PNG page buffers, persists each via the **existing** content-addressed asset write path, returns `{ asset_ids: string[], page_count }` | **Choose** |

**Why B over A:**

1. **`/api/assets` has a hard single-asset contract.** Its return shape is `{ asset: row }` (one row, `app/api/assets/route.ts:55`); its client `uploadAsset` returns one `UploadedAsset` (`src/ui/lib/assets.ts:19-24`). Four call sites and three tests (`app/api/assets/route.test.ts`) assume one-file-in / one-asset-out. Making `/api/assets` polymorphically return either `{asset}` or `{assets: []}` forks every consumer and the type. The asset route should stay "one blob → one content-addressed row".
2. **Rendering is a different cost/latency class.** A 20-page PDF render at 150 DPI is seconds of CPU + N×PNG encodes. Co-locating that in the generic asset upload path (also used for figure crops, single photos) muddies the route's responsibility and its 8 MB image cap semantics.
3. **Keeps the downstream zero-change invariant clean.** After expansion, the produced page assets are **plain `kind='image'` rows, byte-identical in contract to a photo** — content-addressed SHA-256 key, `image/png` mime, `byte_size`, no `width/height/provenance` written (matches `app/api/assets/route.ts:42-53`). Session create still receives pure image `asset_ids`. The Tencent/VLM worker (`tencent_ocr_extract.ts:152-170`) downloads bytes → `sharp().metadata()` → base64 with **zero changes**. The seam is purely "produce `source_asset` image rows," exactly as the prep established.

**Client flow after B:**

```
VisionTab (vision_paper mode)
  ├─ user picks 1 PDF
  ├─ POST /api/ingestion/pdf  (multipart, field 'file')  → { asset_ids, page_count }
  ├─ POST /api/ingestion       { entrypoint:'vision_paper', asset_ids }  → session.id
  └─ POST /api/ingestion/[id]/extract                                     → SSE progress
```

The render endpoint **reuses the asset write helper**, it does not duplicate it. Extract the SHA-256 + `r2.put` + `source_asset` insert from `app/api/assets/route.ts` into a shared `src/server/ingestion/persist-image-asset.ts` (`persistImageAsset(db, r2, { bytes, mime })`) so both `/api/assets` and `/api/ingestion/pdf` write rows identically (content-addressed dedup preserved: re-rendering the same PDF page yields the same key). This is the **only** refactor to the existing asset path.

### Endpoint placement (route handler, not worker)

Render lives **in the route handler** (`app/api/ingestion/pdf/route.ts`, `runtime = 'nodejs'`), synchronously, before session create — NOT in the pg-boss worker. Rationale:
- The user is actively waiting at the upload UI; a 1–20 page render is sub-10s and benefits from synchronous feedback (page_count returned immediately, used for the "PDF · N 页" UI).
- Keeps the worker bundle (`build:worker` esbuild) untouched — no new `--external` entry, no risk to the durable-job path. The renderer dep stays out of `scripts/worker.ts`'s graph.
- The existing extract pipeline already runs in the worker and is unchanged; we only add a pre-step in a route.

**Synchronous-render exposure (critic check — acceptable, with guardrails):** Next.js self-hosted (standalone Node, not Vercel) has **no serverless function timeout**, so a multi-second render will not be killed by the platform. The real exposures are (a) **UX wait** — the user stares at a spinner; bounded by `PDF_RENDER_TIMEOUT_MS = 30_000` (§2) + `MAX_PDF_PAGES = 15`, so worst case is one 30s wait that fails loudly, not a hang; (b) **event-loop / memory** — PDFium WASM render + sharp PNG encode are CPU-bound and synchronous-ish per page; on a single-user NAS tool this is acceptable, but the renderer MUST `await` between pages (it does, via the async sharp `toBuffer()`) so the Node event loop is not starved, and MUST `destroy()` the WASM document/library in a `finally` (§2) so heap doesn't grow across requests. These two are the only things that turn "sync render in a route" from fine into a problem on this runtime; both are already specified. No move to the worker is warranted for the stated 15-page ceiling.

---

## 2. Renderer — library, parameters, failure paths

### Library: `@hyzyla/pdfium` (v2.1.13, MIT)

Per the Map's ranked recommendation. Decisive properties:
- **MIT license**, zero copyleft risk. (Explicitly **reject `mupdf`** — AGPL-3.0, network-use clause triggered by the Cloudflare Tunnel; flag loudly if anyone proposes it.)
- **Zero system deps** — PDFium compiled to WASM and bundled in the npm package (`deps: None`). Runs in the Next standalone Node container with no `apt-get`, no per-arch native binary. This is the decisive differentiator for the NAS Docker / arm64 constraint (rejects the `pdfjs-dist + @napi-rs/canvas` path, whose native binaries have documented ARM/Docker load failures).
- **sharp integration** — PDFium renders to a raw bitmap; pipe into the **existing** `sharp@0.34.5` to encode PNG. No new image-codec dependency.

`pnpm add @hyzyla/pdfium`. Confirm via `query-docs` (Context7) for the exact v2.x render API (`PDFiumLibrary.init()` / `loadDocument` / `getPage(i).render({ scale, render: 'bitmap' })`) before writing the wrapper — the API shape below is the integration intent, verify signatures at implementation time.

> **Critic-verified package facts (registry, 2026-06-06):** `@hyzyla/pdfium@2.1.13`, `license: MIT`, `dependencies: {}` (zero runtime deps — PDFium WASM bundled), independently re-confirmed against the npm registry. One interop nuance: the package is **ESM-only** (`main: undefined`, `types: dist/index.esm.d.ts`). Next server bundling handles ESM, and `serverExternalPackages` (next.config.ts:27) is the escape hatch already named in §2's "Build externalization note" if the `.wasm`/ESM load misbehaves under `pnpm build`. The render-API method names above remain **unverified** until the §9.1 Context7 check — treat them as intent.

### Renderer module: `src/server/ingestion/pdf-render.ts`

```ts
// renderPdfToPngPages(pdfBytes: Uint8Array, opts): Promise<{ png: Uint8Array }[]>
// - PDFiumLibrary.init() once per call (or module-cached); loadDocument(pdfBytes)
// - for each page up to MAX_PDF_PAGES: render at the chosen scale → raw bitmap
//   → sharp(raw, { raw: { width, height, channels:4 } }).png().toBuffer()
// - destroy() the document + library in a finally to free WASM heap
```

### Render parameters (numbers + rationale)

| Param | Value | Rationale |
|---|---|---|
| **DPI / scale** | **150 DPI** (`scale ≈ 150/72 ≈ 2.08`) | PDFium default scale=1 ≈ 72 DPI is too low for OCR/VLM text. 150 DPI is the OCR sweet spot — crisp glyphs without blowing up base64. A US-Letter page at 150 DPI ≈ 1275×1650 px PNG, typically well under the 8 MB per-asset cap. Avoid 300 DPI: ~4×base64 inflation sent to Tencent+VLM **per page** (`tencent_ocr_extract.ts:166,170`). |
| **Max pages** | **`MAX_PDF_PAGES = 15`** | See §3. Render loop hard-stops; pages beyond are not rendered. |
| **Render timeout** | **`PDF_RENDER_TIMEOUT_MS = 30_000`** wall-clock for the whole document | Guards a pathological PDF. `Promise.race` the render against a timeout; on timeout throw `validation_error` "PDF 渲染超时". |
| **Output format** | PNG via sharp | Lossless text edges for OCR; matches existing `image/png` asset contract. |
| **Per-page byte ceiling** | reuse `MAX_UPLOAD_BYTES` (8 MB) per rendered page | If a rendered page PNG exceeds 8 MB (extremely dense page at 150 DPI), fail that render with a clear error rather than silently down-scaling — keeps the asset cap invariant honest. |

### Failure / error paths (all return 400 `validation_error` with a Chinese message; the route try/catch → `errorResponse`)

| Failure | Detection | Response |
|---|---|---|
| **Not a PDF / corrupt** | `loadDocument` throws or magic-byte check fails (`%PDF-` prefix) | 400 `"无法解析 PDF（文件可能损坏或不是有效 PDF）"` |
| **Encrypted / password-protected** | PDFium load throws a password/permission error | 400 `"PDF 已加密，暂不支持。请先移除密码后再上传"` |
| **Too many pages** | `pageCount > MAX_PDF_PAGES` | 400 `"PDF 共 ${n} 页，超过单次 ${MAX_PDF_PAGES} 页上限，请拆分后上传"` (check page count **before** rendering, fail fast) |
| **Zero pages** | `pageCount === 0` | 400 `"PDF 没有任何页"` |
| **Oversized upload** | `bytes > MAX_PDF_UPLOAD_BYTES` (§3) | 400 `"PDF 超过 ${MAX_PDF_UPLOAD_BYTES} 上限"` |
| **Render timeout** | `Promise.race` timeout | 400 `"PDF 渲染超时（${30}s），请尝试更小的文件"` |
| **Rendered page > 8 MB** | post-encode size check | 400 `"第 ${i} 页渲染后超过单页 8MB 上限"` |

Use the existing `ApiError('validation_error', msg, 400)` + `errorResponse(err)` pattern (`app/api/assets/route.ts:25,57`). No new error infrastructure.

### Build externalization note

- **Worker bundle**: untouched (renderer is route-only, not imported by `scripts/worker.ts`). No `build:worker --external` change needed. **Verify** at implementation: grep that `pdf-render.ts` is not transitively imported by the worker graph.
- **Next build**: `@hyzyla/pdfium` ships a `.wasm` asset. Next's server bundler must not mangle the wasm load. If `pnpm build` fails to locate the wasm at runtime, add `@hyzyla/pdfium` to `serverExternalPackages` in `next.config.ts:27` (same mechanism already used for `pg`/`pg-boss`). This is a **build-gate-driven** decision — only add the external if `pnpm build` + a runtime smoke proves it necessary; do not pre-add.

---

## 3. Upper-bound guardrails (numbers + rationale)

| Guard | Current | New value | Where | Rationale |
|---|---|---|---|---|
| **PDF page cap** | n/a | **`MAX_PDF_PAGES = 15`** | `src/server/ingestion/pdf-render.ts` (new const) | Each page is sent base64 to **both** Tencent OCR and the VLM (`tencent_ocr_extract.ts:166,170`) — cost + latency scale linearly. 15 covers a realistic multi-page worksheet/exam while bounding OCR cost and VLM payload. Not infinite. |
| **`asset_ids` max** | `.max(5)` (`app/api/ingestion/route.ts:14`) | **`.max(15)`** | `app/api/ingestion/route.ts:14` Zod | Must rise to admit a 15-page PDF's expanded assets. Pipeline downstream is length-driven (`tencent_ocr_extract.ts:145` loops `assetIds.length`; `page_spans`/`page_index` scale) so raising the ceiling is safe. Keep them **equal** (`MAX_PDF_PAGES === ingestion asset_ids max`) — single source of truth; import the const into the route Zod so they can't drift. |
| **PDF upload size** | photo cap `MAX_UPLOAD_BYTES = 8_000_000` | **`MAX_PDF_UPLOAD_BYTES = 30_000_000`** (30 MB) | `app/api/ingestion/pdf/route.ts` (new const, local to the PDF route) | A 15-page PDF with embedded scans can exceed the 8 MB image cap. 30 MB admits realistic scanned exams while bounding render memory. **Do not** raise the `/api/assets` `MAX_UPLOAD_BYTES` — keep the per-image cap at 8 MB; the PDF route has its own larger cap for the source PDF. (Next App Router route handlers have no framework body limit — the only gate is this app constant, per Map.) |
| **Per-rendered-page size** | n/a | reuse 8 MB | `pdf-render.ts` post-encode check | Rendered page assets still flow through the 8 MB image contract. |
| **VisionTab `maxFiles`** | `5` (`VisionTab.tsx:118`) | unchanged for image picks; PDF is a **single-file** pick that expands server-side | `VisionTab.tsx` | A PDF upload is one file → server returns up to 15 assets. The client `slice(0, maxFiles)` cap (`VisionTab.tsx:322`) applies only to the **image** multi-pick path, not the PDF path. |

**Single-source-of-truth wiring**: define `MAX_PDF_PAGES` in one module (`src/server/ingestion/pdf-render.ts` or a tiny `src/core/limits.ts`), import it into the `/api/ingestion` Zod `.max(...)` so the page cap and the asset-array cap are provably equal.

---

## 4. UI — VisionTab changes

> **Design pre-flight note**: VisionTab is an existing component; this lane modifies upload affordance + adds a render/expand progress phase + multi-page-from-one-file display. Per the project's UI Design Compliance rule, the implementing agent must do the design-doc pre-flight (cite the vision/ingestion design doc sections governing the upload dropzone + phase labels, declare component-type = existing in-route component, list touched files) and get user approval **before** writing the TSX. This plan specifies behavior, not final styling — land it against existing design-system tokens/primitives (`Card`, `Button`, `Icon`, `record-*` classes already in use).

Changes (all in `src/ui/components/VisionTab.tsx`, `vision_paper` mode only):

1. **`accept` attribute** (`VisionTab.tsx:365`): add `application/pdf` → `accept="image/png,image/jpeg,image/webp,application/pdf"`. Keep `vision_single` (single-photo) image-only.
2. **Branch the pick handler** (`onPickFiles`, `VisionTab.tsx:320`): if the single picked file is `application/pdf`, route to the PDF path; otherwise the existing image-array path. A PDF + images mixed selection → reject with a Chinese inline error ("PDF 请单独上传").
3. **New mutation / phase**: add an `expanding` phase between `idle` and `uploading`. The PDF path calls `POST /api/ingestion/pdf` (new `expandPdf` helper in `src/ui/lib/assets.ts`) → receives `{ asset_ids, page_count }` → then proceeds to the existing `POST /api/ingestion` + extract flow with those ids. Phase label: `"展开 PDF（${page_count} 页）…"`.
4. **Progress state**: render endpoint is synchronous, so the UI shows a determinate "展开 PDF…" spinner during the request, then "已展开 N 页 · 上传中…". Reuse existing `mutedStyle` / phase-label rendering (`VisionTab.tsx:411-421`).
5. **Multi-page-from-one-file display**: in the file list (`VisionTab.tsx:389-398`), when a PDF was picked show one row "`<name>.pdf` · N 页" instead of N image rows. After expansion, the review UI (`BlockEditor`, `page_spans` per page) **already** renders per-page blocks correctly — no review-UI change (the assets are plain image rows, served by `GET /api/assets/[id]/content` unchanged).

**Fix the confirmed client bug — PREREQUISITE, not opportunistic** (`src/ui/lib/assets.ts:23`): `uploadAsset` casts `res.json()` directly to flat `UploadedAsset`, but the route returns `{ asset: row }` (`app/api/assets/route.ts:55`). The critic's static trace confirms this is a **live runtime bug, not "tolerated by accident"**: `uploadAsset` has exactly one consumer — `VisionTab.tsx:195-196` does `assets.map((a) => a.id)` → every `a.id` is `undefined` → `POST /api/ingestion` receives `asset_ids: [undefined, …]`, which fails Zod `z.string().min(1)` (`app/api/ingestion/route.ts:14`) or, if it slips past, the existence check (`route.ts:48-51`, "unknown asset_ids"). There is **no test on `uploadAsset` end-to-end** (the route test asserts the wrapped `{asset}` shape at `app/api/assets/route.test.ts:42-51`, so it masks nothing client-side). **Conclusion: the existing photo upload path (both `vision_single` and `vision_paper`) is already broken in production today** — the PDF lane cannot build `expandPdf` on this contract until it is fixed.
> - Fix `uploadAsset` to unwrap `.asset` (return `(await res.json()).asset as UploadedAsset`).
> - The new `expandPdf` helper returns the route's body directly as `{ asset_ids: string[]; page_count: number }` (a **different** shape from `uploadAsset` — do not conflate the two helpers; `/api/ingestion/pdf` returns `{asset_ids,page_count}` flat, NOT wrapped in `{asset}`).
> - **Add a regression test** for `uploadAsset` (unit partition, mock `apiFetch` to return `{ asset: {...} }`, assert `.id` is defined) so this can never silently regress again. Without it the fix is unverifiable and §5 has no coverage of the exact bug being fixed.
> - Because this is a **pre-existing prod bug** independent of PDF, the implementing agent should call it out at lane close (it explains any "上传后抽取失败" the user may have hit) and confirm whether a separate fix-only commit/Linear note is warranted vs. folding it into Commit 3.

---

## 5. Test checklist

> **Partition rule** (`scripts/audit-test-partition.ts`, `vitest.shared.ts`): a `*.test.ts` that imports `tests/helpers/db`, `@/db/*`, `postgres`, `drizzle`, `pg-boss` → **db partition**; pure tests with all DB/R2/AI mocked-before-import → **unit partition** (and must be enumerated in `fastTestInclude`).

### 5.1 Renderer unit test — `src/server/ingestion/pdf-render.test.ts` → **unit partition**

Pure: imports only `pdf-render.ts` + `sharp` (no DB/R2). Add its path to `fastTestInclude` in `vitest.shared.ts` (sibling of `src/server/ingestion/crop.test.ts` already there).

- **Fixtures into repo** at `tests/fixtures/pdf/`:
  - `sample-2page.pdf` — a tiny 2-page text PDF, hand-built as bytes (a minimal valid PDF can be authored from a literal byte string / template, no binary blob needed — keeps the repo clean and the fixture auditable). Document the generator.
  - `encrypted.pdf` — a password-protected PDF for the encryption error path (small).
  - `corrupt.pdf` — bytes that start `%PDF-` but are truncated/garbage.
- Assertions:
  - renders `sample-2page.pdf` → exactly 2 PNG buffers; each `sharp(buf).metadata()` has `format==='png'`, `width/height > 0`, dimensions consistent with ~150 DPI.
  - content-addressed determinism: rendering the same PDF twice → identical page bytes (same SHA when fed through the persist helper).
  - `corrupt.pdf` → throws the parse error.
  - `encrypted.pdf` → throws the encryption error.
  - a synthetic >15-page descriptor (or a small generated 16-page PDF) → page-cap error **before** rendering all pages.

### 5.2 Route test — `app/api/ingestion/pdf/route.test.ts` → **db partition**

Mirrors `app/api/assets/route.test.ts` (imports `tests/helpers/db` + `memR2()` → db partition; do **not** add to `fastTestInclude`). Mock R2 via `vi.mock('@/server/r2', () => ({ getR2: () => memR2() }))`.

- POST a `sample-2page.pdf` multipart → 201/200, body `{ asset_ids: [2 ids], page_count: 2 }`; assert 2 `source_asset` rows written with `kind='image'`, `mime_type='image/png'`, content-addressed `storage_key`, and the bytes are in `memR2._store`.
- POST `corrupt.pdf` → 400 `validation_error`.
- POST `encrypted.pdf` → 400 with the encryption message.
- POST a 16-page PDF → 400 page-cap.
- POST non-PDF mime → 400.
- POST > `MAX_PDF_UPLOAD_BYTES` → 400.
- Re-POST the same PDF → same `storage_key`s (dedup via shared persist helper).

### 5.3 Ingestion Zod cap test — extend `app/api/ingestion/route.test.ts` (existing, **db partition**)

- 15 asset_ids → accepted; 16 → 400. Locks the `.max(15)` change.

### 5.4 End-to-end DB chain test — `app/api/ingestion/pdf/e2e.db.test.ts` → **db partition**

Tracer-bullet of the seam invariant (render → assets → session create → assert pipeline-ready):
- expand PDF → `asset_ids`; feed those into `POST /api/ingestion` → session created with `status='uploaded'`, `source_asset_ids` = the rendered ids; assert each id resolves via `GET /api/assets/[id]/content` to PNG bytes (proves the downstream-zero-change claim: the page assets are indistinguishable from photo assets to the rest of the pipeline). Stop before invoking the live Tencent/VLM worker (out of scope — that path is already covered by `tencent_ocr_extract` tests and is unchanged).

### 5.5 Gate

Run the full pre-PR gate (`pnpm typecheck`, `lint`, `audit:schema`, `audit:partition`, `audit:profile`, `test`, `build` with `DATABASE_URL` placeholder). `audit:partition` will fail if the renderer unit test isn't enumerated in `fastTestInclude` or if a db-tainted test leaks into unit — fix placement until green. `audit:schema` should be unaffected (no new schema columns — see §7).

---

## 6. Commit slicing (3 atomic commits)

Build bottom-up so each commit is independently green (`pnpm typecheck` + the relevant test passes at each step).

**Commit 1 — renderer + shared asset-persist helper (backend core, no route/UI)**
- `pnpm add @hyzyla/pdfium`.
- `src/server/ingestion/pdf-render.ts` (render fn, `MAX_PDF_PAGES`, DPI/timeout consts, error mapping).
- `src/server/ingestion/persist-image-asset.ts` (extracted SHA-256 + `r2.put` + `source_asset` insert; refactor `app/api/assets/route.ts` to call it — `/api/assets` behavior + return shape `{asset:row}` unchanged, asset route test stays green).
- `tests/fixtures/pdf/{sample-2page,encrypted,corrupt}.pdf` + `pdf-render.test.ts` (unit) + `fastTestInclude` entry.
- Message: `feat(ingestion): PDFium page renderer + shared image-asset persist helper (Refs YUK-250)`

**Commit 2 — `/api/ingestion/pdf` route + ingestion cap raise**
- `app/api/ingestion/pdf/route.ts` (multipart → render → persist N assets → `{asset_ids,page_count}`; `MAX_PDF_UPLOAD_BYTES`, all §2 error paths).
- Raise `app/api/ingestion/route.ts` Zod `.max(5)` → `.max(MAX_PDF_PAGES)` importing the single-source const.
- `app/api/ingestion/pdf/route.test.ts` (db), ingestion-cap assertions, `e2e.db.test.ts`.
- Message: `feat(ingestion): POST /api/ingestion/pdf expansion endpoint + raise page cap to 15 (Refs YUK-250)`

**Commit 3 — VisionTab UI + client lib + latent-bug fix (main commit, Closes)**
- `src/ui/lib/assets.ts`: add `expandPdf()`; fix `uploadAsset` `.asset` unwrap if §4 verification confirms the bug.
- `src/ui/components/VisionTab.tsx`: `accept` += `application/pdf`, PDF branch in `onPickFiles`, `expanding` phase + label, single-row PDF file display.
- Any VisionTab UI test under `src/ui/**` (unit partition).
- Message: `feat(ingestion): VisionTab PDF upload (single-file → N pages) + fix asset return-shape unwrap\n\nCloses YUK-250`

> Commit 3 carries `Closes YUK-250`. Commits 1–2 use `Refs YUK-250`. All three append the `Co-Authored-By` trailer per repo policy. UI commit (3) must follow the design-doc pre-flight + user approval gate before the TSX is written.

---

## 7. Schema / audit impact

- **No new schema columns.** Rendered pages are `source_asset` rows written through the existing insert (`kind='image'`, `storage_key`, `mime_type`, `byte_size`, `sha256`, `created_at`). `width/height/provenance` stay defaulted/null exactly as the photo path does today (`app/api/assets/route.ts:42-53`) → `pnpm audit:schema` unaffected, no allowlist entry needed.
- **No `IngestionEntrypoint` enum change.** PDF reuses `entrypoint='vision_paper'` (the multi-page paper flow). The PDF-ness is a pre-step that produces image assets; the session entrypoint stays `vision_paper`. (`src/core/schema/business.ts:139` unchanged.)
- **No subject profile change** → `pnpm audit:profile` unaffected.

---

## 8. DOCX follow-up (file at lane close, do not implement here)

File a Linear issue (search for an existing DOCX/ingest dup first): *"DOCX ingest — choose renderer path"*, blocked-by-decision, capturing the three options from §0 with the AGPL/system-dep tradeoffs from the Map. Reference YUK-250 as the PDF predecessor. Do **not** add LibreOffice to compose without explicit user sign-off.

---

## 9. Open verification items for the implementing agent (resolve at impl time, do not assume)

1. **`@hyzyla/pdfium` v2.x exact render API** — confirm via Context7 `query-docs` before writing `pdf-render.ts` (the `getPage().render()` signature / bitmap channel order feeding `sharp`).
2. **WASM load under `pnpm build`** — if the standalone build can't resolve the `.wasm`, add `@hyzyla/pdfium` to `serverExternalPackages` (`next.config.ts:27`). Build-gate-driven, not pre-emptive.
3. **`uploadAsset` `.asset` unwrap** — ~~verify whether it's a live bug~~ **RESOLVED by critic: it IS a live bug (static trace, single consumer, no masking test).** Fix is now a hard prerequisite per §4 — unwrap `.asset` + add the `uploadAsset` regression test. No further verification needed; just implement the fix.
4. **DPI sanity** — after first real render, confirm a 150-DPI page PNG stays well under 8 MB and that OCR/VLM quality is adequate; adjust DPI within 150–200 if text recall is weak, watching base64 payload size.
5. **Worker-bundle isolation** — grep that `pdf-render.ts` is not transitively pulled into `scripts/worker.ts`; if it is, the renderer must move or be `--external`'d in `build:worker`. (Critic pre-checked: `scripts/worker.ts` imports only `@/db/client` + `@/server/boss/{client,handlers,shutdown}`; neither `pdf-render.ts` nor the new `/api/ingestion/pdf` route is in that graph, and `persist-image-asset.ts` will be imported only by the two routes. Edge is currently clean — the grep is a guard against the implementor accidentally importing `pdf-render` from a worker-reachable module.)

---

## 10. Critic 修正记录 (2026-06-06, PDF lane critic — read-only review, 统合 merged)

**Verdict: APPROVE (no P1 blocker; corrections folded in).** Map facts independently re-verified against live code + npm registry; the seam choice (dedicated `/api/ingestion/pdf` route reusing a shared `persistImageAsset` helper) is sound and the downstream-zero-change invariant is real — the extract worker (`tencent_ocr_extract.ts:145-170`) is byte/base64-driven over `assetIds.length`, so a PDF-rendered PNG `source_asset` row is indistinguishable from a photo row. Renderer license/container conclusions hold with evidence (`@hyzyla/pdfium@2.1.13` MIT, deps `{}`, WASM-bundled; `mupdf` AGPL correctly rejected; `@napi-rs/canvas` native-binary/ARM risk correctly avoided). Guardrail numbers (150 DPI, `MAX_PDF_PAGES=15` kept equal to ingestion `.max()`, 30 MB PDF cap separate from the unchanged 8 MB image cap) are reasonable and single-sourced. Test partition placement is correct (`fastTestInclude` at vitest.shared.ts:20, `crop.test.ts` sibling confirmed; route/e2e tests correctly land in db partition). No over-engineering — reuses `ApiError`/`errorResponse`, sharp, existing asset contract; adds exactly one route + two server modules + UI branch.

**Corrections applied to this doc:**
- **§4 / §9.3 (was the only thing close to a real defect):** Upgraded the "latent client bug — verify" to a **confirmed live prod bug + hard prerequisite**. Static trace: `uploadAsset` (assets.ts:23) returns flat `res.json()` but route returns `{asset:row}`; its sole consumer `VisionTab.tsx:195-196` reads `a.id` → `undefined` → breaks `POST /api/ingestion`. No client-side test masks it. Added a mandated `uploadAsset` regression test and clarified `expandPdf` returns a **different** shape (`{asset_ids,page_count}`, not `{asset}`).
- **§1:** Added a synchronous-render exposure analysis (critic prompt's "will a big PDF blow up the route handler" question): self-hosted Next has no serverless timeout, so the real risks are bounded UX wait (capped by 30s timeout + 15 pages) and event-loop/heap (mitigated by per-page `await` + `destroy()` in `finally`). Conclusion: route-handler render is fine at the 15-page ceiling; no worker move warranted.
- **§2:** Added critic-verified registry facts and the ESM-only interop nuance (ties to the existing `serverExternalPackages` escape hatch); flagged the render-API method names as still-intent pending §9.1 Context7 verification.
- **§9.5:** Recorded the critic's pre-check that the worker import graph is currently clean of the renderer.

**Non-blocking notes left for the implementor (no doc change needed):** (1) the `uploadAsset` bug is independent of PDF and pre-dates this lane — consider whether it deserves its own Linear note at lane close. (2) DOCX descope (§0/§8) is the correct call and must still be surfaced to the user at lane close per the plan.
