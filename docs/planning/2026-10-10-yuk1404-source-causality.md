# YUK-1404 source trace

Baseline: 8b5d0cab53e8a34bd24c6bc78da0d9e9f894060f. Parent investigation followed by the scoped product changes below; no runtime acceptance yet. Read Linear comments 8610c550, 74f55854 including R01 additions before this trace.

## Confirmed source paths

- `ingestion/server/auto-enroll.ts:406` calls `runWorkflowJudge` without `defaultQuestionKind`. `workflow-judge.ts:82` defaults to `reading`; auto-enroll inserts that value at line 614. This explains the uniform kind on that path. Captured-answer `assessment-capture.ts:89` is a distinct writer and uses structured.kind or short_answer: both consumers need review, not just the workflow default.
- `ingestion/jobs/tencent_ocr_extract.ts:601` maps each structured question into a block but gives every block all `figureRefs` and all `assetIds` at 609/618. Auto-enroll later inserts `block.figures` and `block.image_refs`. The existing page-scoping function at auto-enroll.ts:875 only feeds selected downstream calls; it does not correct this persisted material ownership. Do not blindly narrow unknown cross-page evidence or attach sibling figures as a fallback.
- `server/session/ingestion.ts:281–286` persists the structured tree while explicitly setting extracted_prompt_md/reference_md null. Auto-enroll renders questionMd from structured, but copies reference_md from the null legacy column. This is a projection mismatch, not proof the structure has no answer. A canonical shared projection must serve manual/auto/read consumers rather than backfilling mutable fields independently.
- StructureTask's schema has answers/analysis and student_answer_present. Its prompt already forbids transcription of handwriting, yet R03 reports contamination. Prompt text alone is not safety evidence: inspect actual sealed outputs and encode reference-vs-student provenance before accepting answers as trusted reference. Do not promote every extracted answers entry into a key or loosen scoring admission.

## Next implementation boundary

Trace the canonical structured material schema and both manual/native enrollment consumers, then implement a shared material projection with explicit unknown/reference provenance, kind/options and owned figure refs. Verify identity/source-block revision concurrency. Source corrections must remain separate from admission approval and public outcome receipts. UI transport/read-model handoff retains current visuals and Start ownership.

Real acceptance remains the original 14-page/21-question corpus plus R01 blank review/outcome observations: field comparison, zero student-work-to-key promotion, exact owned figures, explicit review/admission next action, actual practice entry. No model, DB, runtime, paid call, test or deployment was performed for this trace.

## First implementation delta

Extraction block construction now filters figures through the existing assignment identity and full question subtree. It no longer copies every sibling figure into every block. Node24 executed the actual function with root/child/sibling/unknown ownership and verified no mutation of the input (source-level smoke only, not DB/model/TEST acceptance). image_refs, structured projection, answer provenance and admission/outcome remain pending; no claim of complete1404 repair.

## Question shape and review projection

The extraction task now accepts and retains the source question kind. A shared ingestion projection supplies kind and ordered choice text to auto-enrollment and native capture, and choice text to manual import while preserving its explicit kind selection. Existing structured option labels remain in the structured source; no scoring authority is inferred from kind.

GET blocks now derives extracted_prompt_md from the canonical structured tree using structuredToPromptMarkdown. VisionTab initializes its review text from this field, so the fix reaches the existing consumer without UI changes or duplicate persisted markdown. Legacy rows without a structured tree keep their prior field.

Parent checks: Node 24 source smoke for the shape helper; typecheck, changed-file Biome, full build and Postman generation passed. The generated Postman artifact was unchanged. No new test files, DB/container/model calls, deployment, independent review or TEST acceptance in this step. T3 delegation still rejects with parent_not_active; no child was created.

Remaining correctness boundary: assessment-normalization reads structured leaf answers directly (including before any row reference fallback). Therefore withholding reference_md alone does not protect against student-work contamination. The next change must carry and enforce source provenance through that path, retain unknown answers, and preserve admission withholding. Capture intent, outcome receipts, review continuation and page-owned original assets also remain open under this same ticket.

## Reference origin enforcement

VLM output now declares printed/student_work/unknown plus the reference page. Mapping into the canonical tree only retains answers/analysis for printed references on a supplied page. Missing origin or invalid page is unknown. The observation survives the StructuredQuestion schema in extraction_evidence; it is a model observation, not verified grading admission. Student pixels/presence and question/options remain intact. Tencent RightAnswer/AnswerAnalysis now remain only in tencent_grading evidence, as the existing ingestion agreement requires.

Seven new tests are limited to the grading invariant and registered in vitest.shared.ts. They execute the real extraction parser/mapping, canonical schema roundtrip and assessment normalization: nested learner/unknown/missing-origin/missing-page/out-of-range references yield missing_reference, a separately printed key on a page containing student work survives, and Tencent suggestions remain evidence without becoming keys. All seven passed. Parent typecheck, lint (exit 0, 210 warnings), partition audit and full build passed.

This change covers new baseline VLM and Tencent fallback extraction, not historical data repair, all rescue/edit writers, actual model source recognition, verified-rule admission, or the full issue acceptance. No DB/provider/runtime was run. Real 14-page acceptance must test that the model does not falsely label handwriting as printed; no claim that an output enum proves visual correctness. T3 thread-send again failed parent_not_active, so the coordination update was not delivered.

## Persisted page-image scope

The existing page selector moved into a pure ingestion module and now serves both judging and extraction persistence. New blocks keep source_asset_ids as the immutable document page-index map, while image_refs uses the question subtree page set. A separately located printed reference page is included. Figure ownership remains the earlier subtree assignment fix.

Parent executed the actual selector under Node24: distinct sibling exclusion, cross-page children, printed reference page, invalid/incomplete mapping fallback and input nonmutation passed. Typecheck and full build passed; changed-file Biome passed. No new test file for this projection-only change, no DB/model/runtime claim.

Remaining boundary: incomplete node page metadata retains the existing all-originals fallback, rather than silently discarding possible learner evidence. This is not final proof that every source-page association is correct. VisionTab also uses image_refs-or-source_asset_ids and combines asset previews with page_spans; root-only page_spans and explicit unknown handling need further contract work before final gold acceptance. No UI file was modified.

Next admission investigation found an existing practice verify-and-promote operation and enable endpoint; continue by checking its authorization, allowed source kinds, revision CAS and receipt before adding any ingestion continuation. Do not create a second publisher or invent a successful next action without a callable consumer.

## Assessment receipt and admission boundary

The existing verifyAndPromote/POST review drafts enable operation explicitly supports only web_sourced and quiz_gen. It is not a valid ingestion continuation as-is. Its source guard was not widened and no owner override was added.

GET ingestion blocks now calls readIngestionAssessmentReceipts with the actual block/version references. The reader supports Db|Tx and uses the existing captured-question identity shared with captureIngestionOriginal, or the explicit imported question link. It joins the canonical question group lifecycle and current revision; no latest-object guesses, dispatch, publication, claim or GET writes. The DTO distinguishes not_created, saved and unknown publication/link integrity. Saved returns revision, availability, admission reason/generation, suspension and withdrawal; it does not claim general practice eligibility or successful verification. A new block version cannot accidentally resolve the prior version's hidden capture.

The public ingestion export supports the future Start consumer while the HTTP blocks route is the live consumer now. OpenAPI/client generation updated only the derived response types; Postman generation was unchanged. Source typecheck/build and API-contract/capability audits passed. The existing capture DB suite now includes a revision-identity and injected-transaction/observer/rollback invariant, but it has NOT been run. DB/HTTP read-effect verification remains required before delivery. No independent review/TEST/provider/deployment occurred.

Still required: an actual ingestion-compatible admission continuation through canonical verification and publication, explicit material-only capture intent, incomplete source-page mapping, rescue/edit reference provenance, and real R03/R01 acceptance. The read receipt is not a replacement for those behaviors.
