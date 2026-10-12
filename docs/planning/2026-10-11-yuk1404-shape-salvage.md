# YUK-1404 question-shape salvage (shape-only slice)

Owner feature thread: mcp9428d3bf. Base: fresh main 78b1446ba. Source: closed PR1637 head
b0257fe516f2e39c6e838aed8cf00464528b61b0 (local), specifically the type/choices patch first
landed in 51527867b ("preserve extracted question shape and review prompt"). This is a
salvage extraction, not a new implementation and not the whole-ingestion repair.

## Salvaged scope (in this PR)

- `ingestion/tasks/structure.ts` — `StructureNodeT.kind?: string | null`, zod
  `QuestionKind.nullable().optional()`, and the prompt field + constraint line telling the VLM
  to emit the original question-type label and to put choice options into `options` rather
  than flattening them into `prompt_text`. The kind label is explicitly NOT grading
  admission and produces no reference answer.
- `ingestion/server/structure.ts` — `nodeToStructured` copies `node.kind` onto the
  StructuredQuestion output (one line, same position as b025).
- `ingestion/server/captured-question-shape.ts` (new) — verbatim helper from b025:
  kind fallback `structured.kind ?? (options ? 'choice' : role==='stem' ? 'reading' :
  'short_answer')` plus `choices_md` as ordered option text (labels stay in the structured
  `options` objects; `choices_md` is the plaintext array the existing frozen assessment
  path expects).
- `ingestion/server/assessment-capture.ts` — capture insert spreads
  `capturedQuestionShape(block.structured)` in place of `kind: ... ?? 'short_answer'`.
- `ingestion/server/auto-enroll.ts` — passes `defaultQuestionKind` into the existing
  `runWorkflowJudge` seam (already present on main at workflow-judge.ts:41/82; it only
  replaces the hardcoded `reading` fallback) and writes `choices_md` on the enrolled
  question insert.
- `ingestion/server/import-completion.ts` — writes `choices_md` from the imported
  structured tree; explicit `block.question_kind` selection is preserved.

`src/kernel/judge.ts` needed no change: the `defaultQuestionKind` consumer seam already
exists on main. Answer/reference semantics are unchanged — no reference_origin /
printed-reference provenance, answers/analysis gating, or scoring behavior is touched.

## Excluded (remains in b025 / other lanes)

reference_origin + printed-reference enforcement and `extraction_evidence`,
pageScopedQuestionImageRefs module move and persisted image_refs scoping,
capture-identity extraction, unanswered-material knowledge_ids relaxation,
GET blocks extracted_prompt_md projection (blocks.ts), assessment review
workflow/client/evidence/receipt, judge.ts re-exports, structured_question.ts
reference_extraction schema, all tests/fixtures/Postman/OpenAPI changes, and every
runtime/DB/provider/paid call.

## Boundaries

- No new tests: the diff touches no data-irreversibility, settlement-determinism,
  concurrency/lock, auth-boundary, or crisis-referral invariant (kind is a persisted
  extraction label, not a grading input; workflow-judge's default only feeds the prefilled
  kind field). Structural/render-data checks are not model-output proof.
- Claim is limited to: VLM-extracted kind/options now reach the three question writers
  instead of being dropped/re-defaulted. This does not claim ingestion as a whole is
  repaired; the 14-page/21-question gold acceptance and answer-provenance repairs remain
  open under YUK-1404.
- Extraction delta vs the reviewed b025 subset was prepared by the implementation lane;
  parent performs the independent check before opening the replacement Draft PR.

## Next step

Parent opens the Draft replacement PR against this branch, then runs the OCR-prerequisite
comparison of the 21+9 reviewed gold actual outputs before any acceptance claim.
