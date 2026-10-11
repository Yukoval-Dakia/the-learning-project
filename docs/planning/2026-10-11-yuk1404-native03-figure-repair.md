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

Historical Node 24.19.0 receipts include four helper-level security tests and passing typecheck, lint and build; lint reports 172 existing warnings. Those tests do not satisfy the owner's 22:15 product-entry rule. The first test invocation found no file because the unit lane uses explicit registration. A first offline replay failed to resolve Zod from `/tmp`; the corrected replay uses the installed workspace package. Both failures and later outputs remain in the log archive.

Test-only consolidation starts at clean `b1eec50405e71d5d2e82770fbeabe9c6b8e3d425`. Before: `figure_attach.unit.test.ts`, 124 lines/four helper-only cases; `assessment-capture.db.test.ts`, 205 lines/two settlement/retraction cases. The helper file and its exact `fastTestInclude` line remain removed. Parent rejected `ac815eca7`'s three capture inputs as forbidden visibility permutations. The correction leaves the existing DB file at 306 lines/three cases, with both original case bodies unchanged. The single new security case starts at `assessment-capture.db.test.ts:117`, makes exactly one capture call at `:166`, projects the persisted issuance at `:186` and asserts public exclusion/private retention at `:190`. There is no capture loop, unknown-visibility variant or helper-only call. Product entry is `assessment-capture.ts:38`, with transaction `:56`, prospective figure filtering `:112`, publication `:135` and capture issuance `:146`; public projection is `src/core/schema/assessment/dto.ts:86`.

One synthetic mixed source block contains student work, an owned crop with verified metadata, a foreign crop with verified metadata and an unregistered crop. The one real capture must persist the original page as private submission evidence while excluding all figures from its question row, frozen revision and public projection. Original block and asset rows must remain unchanged. Verified fixture metadata exists before capture and derives SHA256/size from a decoded 92-byte synthetic PNG. The unchanged product rejects the whole student-work subtree, so this input cannot retain a clean public crop; no positive control is invented. This case does not independently prove the clean-block ownership/digest guards, unknown visibility or extraction's neighboring-page assignment guard. No internal dependency is mocked, and no production asset writer or public export is added. DB execution remains reserved for the parent. Actual source-crop registration, R2 delivery, serving admission and learner acceptance remain unverified; changing tests does not complete public figure delivery. The native03 source replay and archived receipts below remain separate and unchanged. The remaining producer obligation was already recorded on YUK-1404; no new follow-up or tracker write is made in this restricted child task.

Correction receipts on Node 26.10.0/pnpm 11.13.1: typecheck, lint (172 warnings), partition, test policy against `ac815eca7` and build pass. Policy checks one changed case and inherits two. AST comparison against the original `b1eec50405` confirms both original callbacks unchanged and the new callback has one capture call and zero loops. Logs are `/tmp/yuk1404-mixed-capture-ac815eca7-{typecheck,lint,partition,policy,build}.log`; earlier receipts remain separate. No DB test was run.

Evidence: [source replay and gate receipts](evidence/2026-10-11-yuk1404-native03-figure-repair.json), [native03 replay](evidence/2026-10-11-yuk1404-native03-figure-replay.json.gz), [logs and replay script](evidence/2026-10-11-yuk1404-native03-figure-logs.tar.gz), [source patch](evidence/2026-10-11-yuk1404-native03-figure-source.patch.gz).

Parent reports the production review budget complete with NONE; this test correction starts no additional review. Parent owns exact-head CI, later normal composition with fixed PR #1658, and an isolated same-paper product rerun. No merge, DB, container, runtime, browser, OCR, provider, paid call, shared lock or deployment was performed.

The next prospective producer seam is `cropAndUploadFigures` where the exact PNG bytes already exist, together with the existing `persistImageAsset` / `sha256Hex` implementation (`src/capabilities/ingestion/server/persist-image-asset.ts:34` / `:61`). Register future crops through that existing asset ownership path, retain exact crop/source identity and private/unknown visibility, and compare immutable payloads on retries. The current image writer uses `assets/<sha>` and generated IDs, while the crop producer uses `figures/<page>-fig-N.png`; reconcile these existing contracts explicitly before public acceptance. Do not fake hashes, create a parallel registry or backfill historical crop records. This remaining obligation stays on YUK-1404.
