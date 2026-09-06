# YUK-968 — Practice owns learner-visible assessment

## Evidence and decision

The first generated-card actual sample at947be81c was correctly blocked. Its
author used null optional arrays, then regenerated. Independent solving produced
a correct worked answer, but the comparator received only the final number.
YUK-966 fixed those concrete contracts. The remaining QuizVerify result was
grounding pass / knowledge pass / copy unknown / overall needs_review.

The owner requests a working AI-driven learning product, low token consumption
and deep business ownership. We distinguish learner-visible assessment from
question-pool promotion while reusing the existing Practice validators. This is
not another Copilot lifecycle: cards remain durable conversation content, and
this change never creates or promotes a question/artifact.

## One assessment owner

- Practice `learning-content-validation.ts` now owns question/solve/teaching
  orchestration and admission. Copilot owns extraction and matching visible
  content; Notes uses the same existing injected validation contract.
- The request reuses `kernel/tools/types.ts` rather than introducing a second DTO.
- Author task parsing has one implementation, consumed by retained and candidate
  tools. No second tool catalog, evaluator, scheduler or provider was added.
- Generation source comes from the successful root tool observation. Finalizer
  clones its input only when it matches the PreToolUse hash. Private input/output
  are excluded from receipt serialization; only hashes are sealed. Public result
  snapshots and model history do not acquire another copy of source material.
- Practice reparses the actual tool input/output, reuses owner preparation for
  knowledge/subject/material validation, and compares the published question to
  the observed normalized draft. A mismatch stops before paid validation.

## Explicit learner-visible policy

`validation_purpose=learning_content` asks the existing QuizVerifyTask to report
`grounding.basis`: closed_world_givens, discipline_knowledge, source_refs, material,
or insufficient. The field is optional in the shared result schema for older pool
and intervention consumers; the learner-visible owner requires it. This does not
change their historical overall or release-strict grounding contracts.

Admission requires grounding pass, a supported basis, knowledge pass, no failed
or unclear optional axis, affirmative independent answer agreement, and passing
teaching quality. Material requires real bound input and material_grounding pass;
source_refs cannot be claimed when none were provided. Insufficient or absent
basis, any too_close, and overall fail always block.

An overall needs_review may admit only a trace-bound closed-book candidate whose
remaining uncertain axis is copy unknown and whose basis is independently
verifiable givens or discipline knowledge. The raw verifier result remains
needs_review/unknown. The reply explicitly says external originality comparison
was not performed. No claim of global originality or invented source is made.
Ordinary question-pool promotion still follows its original overall policy.

Practice solve-check now has an explicit release_strict consumer mode: complete
blind-solver output and normalized equivalence or confident semantic agreement
are required. Partial, low-confidence or unsupported comparisons do not become
learner-visible success. Existing conservative pool consumers are unchanged.

## Verification and remaining work

- 182 scoped unit, 73 worker/snapshot DB, 16 assessment-owner DB, and 12 retained
  author DB tests passed. These counts overlap separate verification runs and
  are not presented as one deduplicated total.
- Actual-shaped fixtures cover unknown vs observed provenance, tampered input
  hashes/answers/subjects, missing material, contradictory axes, and strict vs
  legacy solve behavior. Only external model calls are mocked.
- Typecheck, build, lint, API generation and architecture checks passed; dependency
  totals remain439/0/47. Literal task dispatch stays explicit for task-census
  auditability rather than hiding task kinds behind a variable.
- The actual harness retains validator inputs/outputs and their digests for the
  generated-card case, requires one generation including failed attempts, and
  checks honest copy-comparison disclosure. Same original distribution exercise
  is still the paid positive gate, not a simpler substitute.
- Initial independent review passed (no P0/P1). Draft PR1349 atf3b6b3b4 has a
  failing CI unit job under investigation; local passes are not exact CI success.
- First actual968 at cleanf3b6b3b4 failed the unchanged90s deadline. One author,
  passing independent solve/comparison and teaching outputs were observed, but
  QuizVerify terminal output was unavailable. Token/cost metadata is not a pass.
  Raw evidence is sealed in `evidence/2026-09-07-learning-content-deadline-actual.json`.
  Estimated cost0.0061130977; pool estimate0.0535364724 (not invoice), reserve7.75823,
  safe2.24177. No live paid process. No reserve reclaimed.
- Inspection found the prompt's required basis missing from its output shape,
  and overlapping pass/needs_review rollups. Align those contracts and capture
  validator start/rejection/timing before another actual; deadline causality is
  not established by these prompt defects. Do not raise the acceptance deadline.
- Prompt alignment and stale QuizVerify-only migration fingerprints are fixed;
  semantic policy assertions remain.211 scoped units, typecheck and build pass.
  Reserve a second0.90 same-prompt actual: total reserve8.65823/safe1.34177.
- Second actual at cleanae7c7a3c confirmed correct7×102=714, one author, all
  validators passing and live/persisted settlement consistency. Unknown external
  originality was preserved and disclosed. Full case still failed: two identical
  presentation nominations violated the unchanged exactly-one control assertion.
  Seal: `evidence/2026-09-07-learning-content-presentation-repeat-actual.json`.
  Estimated0.0067764702; cumulative0.0603129426. Tool description now explicitly
  says successful selection should be followed by normal reply, not repeated.
  Third same-prompt actual reserves0.90: total9.55823/safe0.44177. No new evaluator,
  deadline increase or relaxed count. Sole verification review PASS; budget closed.
  Additional52 pool/assessment DB tests pass. Pre-existing pool rollup inconsistency
  is captured as YUK-969 for independent reproduction; it is not a968 regression.
- No deployment, SoT switch, backfill, production clone or history deletion.
  YUK-967 observation-scope semantics and the overall goal remain open.
