# YUK-1066 / YUK-1071 / YUK-1072 — explicit type boundaries

Raw SQL reads now declare row shapes through Drizzle execute generics. Existing generic
queries consume returned rows directly. This covers session locks, cascade collection,
due questions, durable Copilot dispatch, paper submit/settlement, synthetic reporting and
Urnings replay. SQL text, ordering, locks and transaction boundaries are unchanged.
CascadeRow is a closed type alias compatible with Drizzle's Record constraint.

Golden reaudit is a JSON boundary, despite its original ticket grouping. Its live edge mesh
now passes the existing KnowledgeEdgeRowSnapshot schema before folding; archived edges stay
outside the mesh, and the original golden is not mutated. Invalid weights fail explicitly.

The asset route copies the visible Uint8Array view into ordinary ArrayBuffer-backed bytes,
so Response accepts both ordinary and shared source buffers without type assertions. Tests
cover offsets, binary bytes, MIME/length/cache/ETag behavior and missing objects. The route
contract is unchanged. KT estimates and selection signals use explicit object copies at
JSON persistence boundaries, retaining their enumerable fields and the absent-signal empty
object fallback. Verification profiles/DB handles are SubjectProfile/Db; incomplete test
profile stubs now use real subject profiles. Production caller arguments are unchanged.

Question-kind conversion honestly returns a string because free labels are valid. Skill
lookup narrows via the existing enum schema before indexing its partial map; sourcing
preference lookup continues to accept string keys. The reverse mapper accepts free labels
as well, preserving the existing pass-through contract and canonical round trips.

## Verification

Three malformed live-mesh weight tests fail before the parser change. Scoped unit tests
pass (182 across five files, including rerun of the two changed unit files);226 DB tests
across19 files plus28 sourcing-sequence DB tests pass. Typecheck passes after replacing
incomplete test profiles; no new assertions were added to bypass those errors. Scoped
tests cover session states, cascade limits/cycles, dispatch, due lists, paper settlement,
stream selection, KT persistence, byte response and retained golden replay.
Typecheck, lint (299 existing warnings), build and all10 local pre-PR audits pass.
Postman regeneration produces no change. Independent review, exact-head CI and the
17-minute final-push window are required before merge; final evidence is in the PR.
No SQL migration, UI change, dependency change, production operation or provider call.
Capture: all actionable work belongs to the three existing issues; no new follow-up found.
