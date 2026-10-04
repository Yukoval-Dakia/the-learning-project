# YUK-1047 — Native pi frozen-rule execution

The persisted assessment evaluator could assemble only Jev. Its advanced port
was injectable but had no native implementation. The new explicit `pi` descriptor
assembles `AssessmentRuleJudgeTask` through the existing native pi runner and task
configuration. It requires the published task kind, an admitted slice and a
published unit cost cap. No publisher, existing revision, admission record or
formal entry point is automatically switched.

The task receives frozen question parts, native slot meanings, published unit,
original member identities/responses and material/evidence manifests. It reports
published rule points or a declared holistic level. Code rejects undeclared
rules/levels, scores above the published maximum, invented aggregation fields,
unknown citations and non-original textual quotes. Holistic decisions carry no
invented points. Uncertainty remains pending, never a fabricated zero.

Asset preparation verifies the stored asset identity and fetched SHA-256 bytes,
plus submitted byte length and MIME. Prompt images and student images retain
separate identities and attachment order. Original UTF-8 plaintext is included;
invalid bytes, missing assets, inline images without a versioned binding and
unsupported audio/video/PDF analysis remain pending. Captions and transcripts do
not replace originals. The CommonMark guard reuses the existing parser. The task
adds no browser credential or direct provider client.

One absolute deadline covers preparation, admission and model execution; caller
cancellation reaches the native runner. No transient retry is enabled. The
adapter intersects explicit caller, published unit and configured task cost caps
for admission/accounting; unknown paid cost consumes the full reservation.
Actual over-cap cost is retained and judgment held. This reservation is not a
provider-enforced billing limit: the shared chat runner does not impose a hard
USD ceiling on an in-flight completion. Authoritative price class and amount
remain in the run/cost ledger.

A real-runner database regression exposed an existing cost defect: a MiMo error
with no usage was priced from placeholder zero token counters. The regression
failed before the fix. Two native adapter probes also failed: failed all-zero
usage and no-assistant engine errors supplied placeholder counters. The pi
normalizer marks placeholder zeros as unobserved regardless of stop status.
Native `onProviderStreamEvent` observations distinguish explicitly reported zero
from missing usage; positive observed usage remains usable. The terminal collector carries explicit usage-presence
evidence; the shared price resolver preserves unknown when counts were not
observed, while observed zero usage and genuine reported zero remain zero.
Earlier assistant usage remains usable when a terminal frame omits usage. No
historical rows are rewritten.

Validation uses offline adapter frames and original-byte fixtures, with the real
runner and database lifecycle. It proves the actual task/provider/model/run/cost
binding, one-attempt failures, original assets and pending outcomes. Native
assembly and missing-usage regressions first failed. Existing Jev, catalog,
provider runner and frozen evaluator regressions are included. This supplies no
new actual-output accuracy or slice-admission evidence, and makes no paid call.

The task census grows from 53 to 54 with a statically visible production consumer;
exact catalog assertions are updated, and architecture debt limits are unchanged.
The eight formal serve/draft/submit/activate/read routes and legacy removal remain
under YUK-1047. The new native descriptor is standalone; it does not silently add
a fallback to already-issued Jev plans.

Author validation: 374 distinct scoped unit cases (330 core/catalog/runner cases
and 44 native adapter cases) and 48 DB cases. Typecheck, lint, build and ten
audits are the local gate; final results are recorded in the PR. Independent
initial review and exact-head CI remain outstanding.

Initial independent review found two P1 accounting failures, reproduced before
repair in three formal DB regressions: a failed $0.168 attempt returned only a
$0.02 reservation, permitting another unit past a $0.04 plan cap; a successful
real pi completion without usage returned a false zero. `AgentRunError` now
carries lifecycle cost truth to the assessment port. The native stream observer
retains explicit usage evidence without persisting raw events. Offline real-driver
tests cover missing, explicit zero and positive usage, including stream iteration.

Initial CI 37232144534 failed one exact structured-judge inventory assertion:
the newly registered task makes five judge tasks, not four. The exact list now
includes the new structured task; no assertions are removed. The sole independent
P0/P1 verification and corrected-head CI are required before merge.

After the consolidated repair: 281 scoped unit cases and 30 DB cases passed,
with typecheck, lint (299 existing warnings), production build and eleven audits.
The independent review observed no other confirmed P0/P1. All real-driver calls
use an offline fetch fixture.
