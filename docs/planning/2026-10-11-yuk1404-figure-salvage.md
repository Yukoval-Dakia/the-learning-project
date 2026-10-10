# Per-question figure ownership salvage

Owner: feature backend thread mcp:9428d3bf-c4a0-4c7b-b39c-b295f1d734f8. Replaces the figure-binding portion of closed PR1637, immutable source b0257fe516f2e39c6e838aed8cf00464528b61b0. Fresh base is main78b1446ba.

Extraction currently stores the entire document figure list on every question block. The existing assignment already identifies a structured question or one of its sub-questions. This patch preserves that assignment and stores only figures whose attached_to_index belongs to the current structured subtree. Figure bytes, provenance, assignment heuristics and document pages are unchanged. The helper has one live consumer in the existing extraction job.

The function and consumer change are copied from the independently reviewed old draft. This extraction does not include the printed-reference workflow, page narrowing, HTTP routes, UI, KC policy, AI admission or a new OCR path. Old R1/R2 budget and evidence stay attached; no third old-scope review is requested. The parent's extraction comparison and local gates are separate from independent review and real photo acceptance.

Next step: exact-head CI plus reviewed nine-photo and synthetic21 figure-binding comparison through the product. The photo path requires OCR. The coordinator has now approved first-call calibration and a ¥5 total OCR cap; budget/runtime preflight still precedes that call. No OCR call has been made. Parent owns acceptance; Opus consumes the existing structure. This draft is not completion of YUK-1404. The accepted truth remains outside git, with unknown fields and misprint-dependent questions separately excluded.

Local validation: typecheck/lint/build and a direct invocation of the real helper verify source and membership behavior only; no new DTO or model-mock tests. No DB/container/provider/deployment work. The original source and unrelated figure-reader consumers are retained.
