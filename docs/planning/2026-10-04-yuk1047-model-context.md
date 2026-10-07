# YUK-1047 — Preserve frozen question context in model evaluation

The model-unit port previously received scoring rules, answer entries and declared
unit materials, but omitted the question prompt and ResponseSpec. Native option
IDs therefore reached the model without their original meanings. A valid
published two-part fixture reproduced both missing-context assertions before the
change; no provider call was made.

The port now carries frozen question parts and slot specifications. A unit's
slot/evidence-slot references select the relevant parts; a group-only unit uses
the issued scope. Parts bring their declared stimulus materials as well as the
unit's explicit material references. Unissued or unrelated parts and materials
are excluded. Original identities, option meanings, table layouts and material
bytes are retained, with no current-question lookup or historical rewrite.

Jev's typed state includes these fields, so its lifecycle input hash covers the
actual question context. Binary question materials and text assets without frozen
inline bytes cannot be graded by this text-only transport: they go to an already
injected advanced executor under the existing deadline, or return explicit
missing_materials. Captions, alt text and transcripts cannot stand in for original
image/audio/video/PDF evidence. Seven material cases failed before this guard;
inline text remains usable. This adds no model, credentials, paid calls or default
advanced executor, and invents no admission threshold.

Validation covers opaque choice IDs, dependent multi-submission context,
group-only scope, stimulus dependencies, unrelated private material exclusion,
original-object preservation and the real typed transport request. A real
publisher/issuance/submission DB regression changes the current published prompt
and option text before evaluation; the old submissions still send their original
frozen context and remain unchanged. Candidate evaluation writes no learning.

94 scoped unit tests and 72 distinct DB cases across four files pass (55 initial
DB cases, then 37 evaluator/joint cases including the new revision regression).
Typecheck, lint (299 existing warnings), build and ten local audits pass. Independent
initial review passed 84 unit / 21 DB and found one P1: rendered inline images
in prompts, native option text or text materials bypassed the material-kind
guard. Three formal location regressions first failed (45 soft assertions); the
fix uses the already-installed renderer’s synchronous CommonMark parser, without
mounting or fetching. It covers inline/reference/nested images and preserves
code, escapes, unresolved references and raw HTML as literal text. Matching and
ordering item text also uses this guard. Inline question images have no synthetic
material IDs: they delegate or return unjudgeable. Seven literal-text negatives
remain gradable. The sole P1 verification review and final-head CI are pending.

This is part of the original eight-entry-point migration. Those callers still use
the legacy evaluator and YUK-1047 remains open until the full serve/draft/submit/
activation/read path is wired and the legacy branch removed. No UI or deployment
changes are included here; no actual-output accuracy claim is made.
