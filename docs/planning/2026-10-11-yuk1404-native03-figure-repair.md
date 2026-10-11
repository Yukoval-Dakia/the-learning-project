# Native03 figure ownership repair (YUK-1404, PR #1657)

This candidate fixes prospective question-level figure binding and public figure input filtering. It does not complete public figure delivery. The original native03 source, block rows, source assets, revisions and failed SWE-2 / GLM5.3 / K3 attempts remain historical evidence.

## Behavior

- Extraction records `figure_ids` against generated `structured.id`; the printed `question_no` is never used as an array index. The StructureTask receives each crop's actual page and bbox.
- An explicit VLM claim must identify exactly one existing node. Missing, low, invalid or conflicting claims stay unbound; the code never guesses the first or nearest question. The OCR fallback requires unique innermost containment on the actual page, excluding page-level placeholders.
- A new question block retains only figures belonging to its own structured subtree. Student-work pages are withheld from diagram assignment. Source pages and R2 crops remain available; extraction warnings identify unbound crop asset IDs.
- Auto-enroll and original capture both filter future question-row figures. Publication requires the block's actual page/crop identity, a matching existing crop storage key, SHA256 asset metadata and explicit clean visibility. Missing visibility stays unknown. Explicit `student_answer_present:false` survives structure conversion; it does not certify an entire page. A full-page crop cannot become a public figure through one clean node.
- Existing captures keep their IDs, original-input digest and replay behavior. The source digest still includes original block figures. No historical row is rewritten.

## Observed source evidence and offline replay

Input: `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/real-pipeline-zj-papers/pdf-native-observation-03/final-output.json`, plus its `figure-binding-surprise-p1.json`. Input SHA256 and candidate source-file hashes are sealed in the replay artifact.

| Paper | Recorded blocks | Foreign source bindings before | Owned source figures after | Foreign source bindings after |
| --- | ---: | ---: | ---: | ---: |
| Math | 19 | 18 | 1 | 0 |
| Physics | 18 | 476 | 27 | 0 |
| Chemistry | 18 | 187 | 11 | 0 |

Math crop `tf4u7mdmlgz13uvaz20q2607-fig-0`, source page 3, names Q18 structured ID `xx80mbdcyjq2ebvpy23layfb`. Recorded Q15 (`bpzuipo7e24fbvqqz0pv2qjt`) nevertheless used it in both scoring parts. Replaying the real helper and unchanged pure contract normalizer excludes it from Q15 and retains it only on Q18's source question. Physics's one low-confidence figure is withheld; no replacement owner was invented.

This replay uses persisted `attached_to_index`, not a new provider result. The snapshot does not contain the original StructureTask `figure_ids` response. Constructed coordinate probes separately exercised unique containment, wrong pages, tied boxes, nearest-only placement and missing/conflicting claims. They are algorithm evidence, not paper annotations or live acceptance.

Prospective public replay emits zero figures: no verified crop metadata is supplied, and old output also lacks explicit clean-visibility evidence. Native03 crop materials have `unverified:<asset_id>` digests. The actual source crop producer writes only R2, so this candidate deliberately withholds these bytes from new public question materials. This is a source limitation, not public figure acceptance.

## Production consumer trace

1. `src/capabilities/ingestion/server/crop.ts:30` / `:55`: normalized page bbox becomes PNG bytes and `figures/<page-asset>-fig-N.png`; the returned crop has source page and bbox.
2. `src/capabilities/ingestion/jobs/tencent_ocr_extract.ts`: builds crop descriptors, calls the existing StructureTask, assigns crop indices to structured IDs, filters each top-level block and passes blocks to `Ingestion.applyExtractionResult`.
3. `src/capabilities/ingestion/server/structure.ts`: `nodeToStructured` generates node IDs and records each `figure_ids` claim against that exact ID. Shape/kind changes from pending PR #1658 are absent on this branch and were not copied.
4. `src/server/session/ingestion.ts:218` / `:283`: the existing capture writer persists each block's filtered figures.
5. `src/capabilities/ingestion/server/auto-enroll.ts:605` / `:634` / `:674`, and `assessment-capture.ts:88` / `:112` / `:135`: load existing asset metadata, filter future public figure inputs, insert a new question and invoke the unchanged publisher in the existing transaction.
6. `src/kernel/records/assessment-publication.ts:898` / `:906` / `:909`: reads `source_asset.sha256` and calls the existing contract normalizer. `assessment-normalization.ts:614` / `:667` / `:671` turns that row's figure list into shared material IDs for its leaves. Consequently foreign figures must be excluded before this boundary.
7. `src/core/schema/assessment/dto.ts:140` / `:163` / `:165`: the real public issuance projection keeps public, frozen digest-bound materials and their `material_ids`. `src/server/questions/detail.ts:285` also returns the row figure list, so excluding unverified/private figures from that row matters independently of serving admission.

These are production paths, not test-only consumers. No publisher, normalizer, scoring, schema, route, UI or provider change is included. Within a structured root, the unchanged normalizer still shares the row figure list across its leaves; this patch establishes question-subtree ownership and does not claim new leaf-specific material routing.

## Validation and handoff

Node 24.19.0: four scoped security tests cover student-work privacy, source/crop metadata, unknown visibility with a verified clean positive control, and a neighboring student's page. Typecheck, lint and build pass; lint reports 172 existing warnings. A first test invocation found no file because the unit lane uses explicit registration; only this new security file was added to `fastTestInclude`. A first offline replay failed to resolve Zod from `/tmp`; the corrected replay uses the installed workspace package. Both failures and later outputs remain in the log archive.

Evidence: [source replay and gate receipts](evidence/2026-10-11-yuk1404-native03-figure-repair.json), [native03 replay](evidence/2026-10-11-yuk1404-native03-figure-replay.json.gz), [logs and replay script](evidence/2026-10-11-yuk1404-native03-figure-logs.tar.gz), [source patch](evidence/2026-10-11-yuk1404-native03-figure-source.patch).

Parent owns different-model independent review, exact-head CI, later normal composition with fixed PR #1658, and an isolated same-paper product rerun. No author self-review, merge, DB, container, runtime, browser, OCR, provider, paid call, shared lock or deployment was performed.

The next prospective producer seam is `cropAndUploadFigures` where the exact PNG bytes already exist, together with the existing `persistImageAsset` / `sha256Hex` implementation (`src/capabilities/ingestion/server/persist-image-asset.ts:34` / `:61`). Register future crops through that existing asset ownership path, retain exact crop/source identity and private/unknown visibility, and compare immutable payloads on retries. The current image writer uses `assets/<sha>` and generated IDs, while the crop producer uses `figures/<page>-fig-N.png`; reconcile these existing contracts explicitly before public acceptance. Do not fake hashes, create a parallel registry or backfill historical crop records. This remaining obligation stays on YUK-1404.
