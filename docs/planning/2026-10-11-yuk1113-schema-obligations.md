# Reserved-field audit obligations

Owner: feature backend thread mcp:9428d3bf-c4a0-4c7b-b39c-b295f1d734f8. This standalone fix restores the contracts gate and does not deliver any reserved capability. Source census is pinned to main 7552977812f3e326e6beb18ebd3ff6495fb3a028.

| Field | Real current state | Delivery obligation |
| --- | --- | --- |
| answer.vision_extracted | answer-draft.ts autosave/freeze writes content_md and image_refs, not this column; migration capture/redaction only reads | YUK-1404 image-attempt writer plus actual attempt consumer, never student work as key; or approved compatible retirement preserving history |
| mastery_state.calibration_residual | schema declaration and migration reads; rehearsal null is a fixture, no mastery producer | YUK-1470 / ADR-0070 D3-D6 intended sealed-prediction/outcome residual producer plus deterministic calibration consumer, or approved compatible retirement |
| mastery_state.fluency_illusion_flag | schema declaration and migration reads; rehearsal null is a fixture, no production producer | YUK-1470 / ADR-0070 D2,D8 evidence-supported producer plus intended learner-state consumer under the process-evidence gate, or approved compatible retirement |
| event_subscription_checkpoint.paused_at | runtime raw SQL never writes this field; the status/paused_at test mutation is only a fixture | YUK-1113 dispatcher pause/resume production writer and behavior verified together, or compatible retirement preserving state |

2026-10-18 is the next explicit review date for each open obligation, not a delivery promise. Expiry validation remains unchanged and fails again if the fields are still unresolved after that date. ADR-0070 does not force reuse of the legacy mastery columns; field repurposing, fake null producers, calibration/mastery changes and schema deletion are outside this PR. DBOS/judge migration or CI success cannot discharge pause/resume.

Local before audit: exit1, four expired exceptions on 2026-10-11 (947 fields audited). The symlinked dependency attempt failed before the audit; retained separately, followed by an isolated offline frozen install and the actual red audit. No DB, container, provider or deployment operation is involved. Validation and independent review results are recorded in the PR against its fixed head.

Linear capture: existing YUK-1113 remains the unresolved-field census; YUK-1404 and YUK-1470 own the named consumers. No duplicate implementation ticket is needed, and none of these tickets is closed by this audit metadata repair.
