# YUK-1061 / YUK-1082 — assessment correctness

## Behavior

Exact text criteria now declare answer_head normalization, matching the existing
kernel comparator and legacy exact judge: extract answer head, then NFKC, trim and
case-fold. The normalizer creates these criteria only for exact overrides or
exact-capable standalone fallback answers; keyword/rubric rules and choice keys
remain unchanged. Unit tests pass normalized contracts through the real evaluator,
covering answer prefixes, explanations, fullwidth/case variants, alternate keys and
incorrect answers.

Synthetic seed:<subject>:root IDs remain evidence/structural labels but are excluded
from theta knowledge write targets in solo and paper settlement. Mixed bindings update
real knowledge only; root-only bindings update no mastery rows. Deferred late-arrival
checks use the same filtered knowledge set and project frozen global-domain mappings
through that set, so a newer root/domain row cannot incorrectly suppress a real KC
update. Newer real-KC/global-domain rows still enforce the watermark. The canonical
question primary key used for family calibration remains unchanged.

The pending-attempt producer uses the same real-KC filter for its frozen domain map
and top-level write targets while retaining the full question snapshot. The reader
also handles existing immutable pending evidence: domain overlap must correspond to
a real KC in the frozen map; root-only records without a map cannot create a domain
collision. Older records without a frozen map but with real KCs retain their recorded
domain evidence, preserving the pre-freeze watermark contract. No old event is edited.

## Historical boundary

Published revisions and past judgements are immutable. The DB regression publishes
an old trim contract, regenerates the same question through the new normalizer and
republishes with both CAS tokens. It verifies a new revision/digest, supersedes link,
advanced lifecycle generation, unchanged old revision and repeat-publish no-op.
It does not upgrade pinned issuances or regrade old submissions.

Before production use on existing exact contracts, inventory current revisions with
text_key/trim, regenerate from the corresponding source through the normalizer, review
the contract/digest diff and republish through publishQuestionGroup with current revision
and admission-generation CAS. Re-verify admission for the changed scoring basis. Never
UPDATE historical scoring JSON in place. This deployment/ops step is not executed here;
reviewed migration/registry handling remains tracked in YUK-1105. Historical root cleanup
and question rebinding remain owner-ops YUK-1083; this patch only corrects future writes.

## Verification

Initial reproduction:4 unit failures and6 DB failures before source changes.
Candidate71 unit tests and61 real Postgres tests across5 files pass, including publisher republish,
solo/paper root-only/mixed mastery, four deferred root/real knowledge/domain guards,
and6 pending-evidence cases covering new/old root-only and real sibling records.
Independent initial review found one P1 in the pending-evidence producer/read path;
4 failing DB regressions reproduced it before the corrective patch. The corrected
full scoped DB run passes; the single verification review is pending.
Required typecheck/lint/build/audits and independent review are recorded in the PR;
exact-head CI and the final-push17-minute merge window are still required.
No UI, production operations or AI-provider calls.
