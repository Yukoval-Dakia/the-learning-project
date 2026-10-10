# YUK-1404 source trace

Baseline: 8b5d0cab53e8a34bd24c6bc78da0d9e9f894060f. Parent investigation; no product repair or runtime acceptance yet. Read Linear comments 8610c550, 74f55854 including R01 additions before this trace.

## Confirmed source paths

- `ingestion/server/auto-enroll.ts:406` calls `runWorkflowJudge` without `defaultQuestionKind`. `workflow-judge.ts:82` defaults to `reading`; auto-enroll inserts that value at line 614. This explains the uniform kind on that path. Captured-answer `assessment-capture.ts:89` is a distinct writer and uses structured.kind or short_answer: both consumers need review, not just the workflow default.
- `ingestion/jobs/tencent_ocr_extract.ts:601` maps each structured question into a block but gives every block all `figureRefs` and all `assetIds` at 609/618. Auto-enroll later inserts `block.figures` and `block.image_refs`. The existing page-scoping function at auto-enroll.ts:875 only feeds selected downstream calls; it does not correct this persisted material ownership. Do not blindly narrow unknown cross-page evidence or attach sibling figures as a fallback.
- `server/session/ingestion.ts:281–286` persists the structured tree while explicitly setting extracted_prompt_md/reference_md null. Auto-enroll renders questionMd from structured, but copies reference_md from the null legacy column. This is a projection mismatch, not proof the structure has no answer. A canonical shared projection must serve manual/auto/read consumers rather than backfilling mutable fields independently.
- StructureTask's schema has answers/analysis and student_answer_present. Its prompt already forbids transcription of handwriting, yet R03 reports contamination. Prompt text alone is not safety evidence: inspect actual sealed outputs and encode reference-vs-student provenance before accepting answers as trusted reference. Do not promote every extracted answers entry into a key or loosen scoring admission.

## Next implementation boundary

Trace the canonical structured material schema and both manual/native enrollment consumers, then implement a shared material projection with explicit unknown/reference provenance, kind/options and owned figure refs. Verify identity/source-block revision concurrency. Source corrections must remain separate from admission approval and public outcome receipts. UI transport/read-model handoff retains current visuals and Start ownership.

Real acceptance remains the original 14-page/21-question corpus plus R01 blank review/outcome observations: field comparison, zero student-work-to-key promotion, exact owned figures, explicit review/admission next action, actual practice entry. No model, DB, runtime, paid call, test or deployment was performed for this trace.
