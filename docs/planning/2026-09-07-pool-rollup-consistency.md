# YUK-969 — question-pool rollup consistency

Legacy `quiz_verify` promotion now requires copy-safety resolution in addition to
the existing positive overall/structured-check gate. Therefore
`overall=pass` with persisted `copy_safety=unknown` remains `draft` with
`verification.status=needs_review`; the raw unknown judgment is preserved and
the paid solve/teaching validators are not started. Existing `too_close`,
grounding, knowledge, material, kind, recovery, and budget behavior is unchanged.
