# YUK-969 — question-pool rollup consistency

Legacy `quiz_verify` promotion now requires copy-safety resolution in addition to
the existing positive overall/structured-check gate. Therefore
`overall=pass` with persisted `copy_safety=unknown` remains `draft` with
`verification.status=needs_review`; the raw unknown judgment is preserved and
the paid solve/teaching validators are not started. Existing `too_close`,
grounding, knowledge, material, kind, recovery, and budget behavior is unchanged.

Pre-fix real-DB fixture returned verified instead of needs_review (RED); after the
fix,37 pool cases pass. Independent reviewer reran the new case and approved.
Root integrated with current YUK-968 learner policy and YUK-967 reader contract:
100 DB/41 unit, typecheck/lint/build and architecture gates pass. No paid call or
production action. Exact-head CI is still required before delivery.
