# YUK-1047 — Frozen public material bodies

## Problem and scope

The normalized revision stores long shared reading/table text in `content_md`, but
`projectPracticeIssuance` omitted those bytes. Composite child faces contain only the
question, so the standalone contract issuance/recovery API could not restore the
reading passage. The same material collection also contains private root rubric
bytes: copying every body into the public DTO would expose scoring input.

This slice corrects that projection boundary before the eight formal entrypoints
migrate. It does not switch those callers, render UI, deploy, or call a model.
YUK-1047 remains open; #1558 already corrected misleading release evidence.

## Contract

- Public material DTO carries optional `content_md`, copied exactly from the pinned
  revision after binding/digest validation. No current question-row lookup.
- New normalized rubric materials have optional `visibility: private`. The schema
  has no default, so parsing a historical revision adds no field or digest change.
- The normalizer's existing reserved `rub_<12 lowercase hex>` asset namespace is
  always private, including old unmarked revisions. Caption text is not a policy.
- The public projection removes private material bodies, metadata and face refs.
  Internal revision material bytes, part refs and issuance binding remain complete
  and unchanged. The wire's opaque frozen binding IDs/digests remain available;
  they contain no rubric text. The public material/face collection is filtered.
- No database rewrite or revised binding derivation: re-issuing an old ID must not
  become a conflict because a new reader changed the historical payload.
- Future publication through the normalizer records the visibility field in a new
  revision's digest; it does not mutate stored revisions or preserve admission by
  overriding the publisher's existing content-change rules.

## Verification

Nine semantic unit assertions failed before the fix (missing exact body, private
material exposure and missing writer marker, and wire schema dropping the body).
Scoped tests cover long Unicode/math/table Markdown, partial part scope, explicit
and historical private assets, immutable JSON, stale-digest rejection, and both
create/recovery wire schemas. Real isolated PostgreSQL tests publish both current
and historical unmarked revisions, issue them, change and republish the working
question, and verify old recovery/replay still returns the exact original body
with unchanged stored revision and issuance rows. Existing submission and publisher
tests also run. Delivery gate results are recorded below when complete.

Local validation: 72 scoped unit and 51 DB tests (23 issuance/submission/recovery,
28 publisher) pass. The corrected typed rubric fixture was rechecked with both
material recovery scenarios. Typecheck, lint (299 unchanged warnings), build and
all ten prescribed audits pass. Independent review and exact-head CI are pending.
