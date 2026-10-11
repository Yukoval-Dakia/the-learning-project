# YUK-1404 figure-binding salvage — scoped delivery evidence

Writer lane: `fix/yuk-1404-figure-binding-salvage`, sole-writer scope =
`jobs/tencent_ocr_extract.ts`, `server/figure_attach.ts`,
`docs/planning/2026-10-11-yuk1404-figure-salvage.md`, this doc.
Head at evidence time: `c99b0f59839fc4e638da48ed94c1f3f1afd28535` (before this
docs commit). Product diff = +8 lines in `figure_attach.ts`, ±1 import + ±1
call site in `tencent_ocr_extract.ts`.

## Review inheritance (verified against git, not assumed)

- Independent reviews of closed PR1637: R1 range `8b5d0cab5..19420aa15`
  (41 files, patch SHA256 `4df7ab391f3d0c5a27ac6fafc27bd923e5ea4d0a527f898db2dd38b6abd9374d`,
  sole P1), R2 completed at `d691f9d01077` with NONE. Source:
  `docs/planning/2026-10-10-yuk1404-parent-validation.md` inside the 1637 diff.
- Figure-binding commit `9197e5dba41d` is an ancestor of both `19420aa15c09`
  and `d691f9d01077` (`git merge-base --is-ancestor` → both true) — inside the
  reviewed range.
- `git log d691f9d01077..b0257fe516f2 -- tencent_ocr_extract.ts figure_attach.ts`
  → empty: the two files did not change between the R2-reviewed head and the
  immutable source `b0257fe516f2e39c6e838aed8cf00464528b61b0`.

## Whole-product-diff byte-identical-subset proof (vs reviewed head b0257fe)

Method: `gh pr diff 1657` vs `gh pr diff 1637`, compare added-line sets per file.

- `figure_attach.ts`: 8/8 added lines present in the 1637 diff; git index
  `1c65493e3..86ae210b2` identical in both diffs (same pre- and post-image
  blobs — byte-identical file change).
- `tencent_ocr_extract.ts`: 6/6 added lines ⊆ the 8 added lines in the 1637
  diff; same pre-image blob `b8c85b4b4`. The two lines 1657 does not take are
  the `pageScopedQuestionImageRefs` import and the `image_refs:` call — the
  deliberately excluded page-scoping portion.
- Only file outside the subset: `docs/planning/2026-10-11-yuk1404-figure-salvage.md`
  (new evidence doc, not product code).
- Per the coordinator policy correction: this records the proof; whether the
  exemption applies or an initial review is commissioned is the parent's call.
  No review-budget exhaustion is claimed.

## Consumer proof

`figuresForQuestion` has exactly one consumer: `tencent_ocr_extract.ts:613`
(`figures: figuresForQuestion(q, figureRefs)` inside `processOneOcrJob`).
`assignFigures` / `assignFiguresFromVlm` are unchanged (diff is additive
only). No new test file — test policy allows none here; behavior is verified
by real-function replay below.

## Retained checks

- Exact-head CI Gate run `38062883863` @ `c99b0f598`: all jobs SUCCESS
  (typecheck·lint, audits ×3, unit 2/2, db 4/4, migration smoke, production
  build, Rust parity, aggregate, CodeQL).
- Parent-reported local typecheck/lint/build pass at draft open
  (Linear YUK-1404 comment 2026-10-10T15:22Z). Re-verified locally after this
  docs commit: typecheck exit 0, lint exit 0, build exit 0.

## Stored-output replay — synthetic21 (actual output, no provider/DB)

Inputs: real extraction blocks persisted during the R03 TEST run `d3781e3fb`,
sealed outside git at
`tlp-audit-artifacts/yuk1388/stage4/R03/evidence/A-b{1,2,3}-blocks.json`
(3 batches 5/5/4 pages, 21 blocks). Every block carries `structured` and
`figures`; within each batch all blocks carry the identical figure list — the
persisted bug itself. `block.structured` = the job's `q`; `block.figures` =
the unfiltered `figureRefs`.

Replay: real `figuresForQuestion` bundled from `c99b0f5` source via esbuild
(`/tmp/yuk1404-replay/driver.mjs`), applied per block over its own stored
inputs. Result: `replayed.json` (this run's output).

- Gold owner truth (`scripts/acceptance/gold/gold.json`, figure-dependent
  pages M04/M11/P01/P02): 4/4 figures land on exactly their owning question —
  M04-1, M11-1, P01-1, P02-1 — matching the `attached_to_index` assignment
  recorded in the stored output.
- 21/21 blocks produce exactly the expected figure set; 0 mismatches.
- Persisted bug state vs replay: b1 9/9 blocks held the M04 figure (now 1/9);
  b3 5/5 blocks held all 3 batch figures (now each only on its owner);
  b2 unchanged (no figures). No figure is lost — every stored
  `attached_to_index` resolves inside exactly one block subtree.

Scope honesty: this proves the deterministic filter on real stored upstream
output. It does not prove the structure/VLM stage will assign
`attached_to_index` correctly on a new run; in this stored run it did.

## Stored-output replay — nine photos (honest gap)

No stored structured output exists for the nine real photos. The only stored
pipeline-stage artifact is the OCR-layer calibration response for
`01_math_parabola_1p/IMG_1083.jpeg`
(`working-reference-20261010/measurement-20261011/ocr-first-call-01/raw-response-9dd5e3cd6ea89858.json`,
attempt `yuk1404-glm-ocr-01-6a55dbc20dd43035f8cd9af0`):

- GLM-OCR emitted 2 `image` regions (stored frame x1y1x2y2, 4032×3024,
  EXIF-6 upright 3024×4032): `[2350,1421,2804,1841]` → upright
  `[1182,2350,421,420]`, matching truth `01…#Q5-fig1` `[1180,2360,420,420]`
  within ~2px x / ≤24px y; `[584,2225,795,2432]` → upright `[591,584,208,207]`
  = the top-left QR-style code, a non-question decoration per truth.
- That is detection-layer evidence only. The binding stage needs
  `(structured, figureRefs)`, which exists only inside `processOneOcrJob`
  after the structure task; it was never persisted outside the DB and no
  photos9 extraction run has occurred. Claiming binding proof from the OCR
  layer alone would be fabrication; it is not claimed.
- Reviewed photo truth: 18 figure-bearing questions, 23 expected figure
  specs (`photos-expected.coordinator-reviewed.jsonl`, sha `ef23229a…620`,
  manifest `672a53b5…827`, dir
  `~/Desktop/test-data/working-reference-20261010/sealed-reference-coordinator-reviewed-v2/`).

## Actual remaining end-to-end blocker

From the most recent preflight/coordination record (Linear YUK-1404
2026-10-10T17:19Z): the pipeline's per-request reservation wiring is still
unimplemented/unproven ("流水线所有请求的预留接线仍待实现证明"). The minimal
merge path is therefore:

1. Parent completes the guarded per-call reservation wiring proof for the
   pipeline lane (already coordinated; separate writer on released arm tree).
2. Actual pipeline run over gold21 + photos9 on an isolated DB — the run
   produces the missing stored `(structured, figureRefs)` for the photos.
3. Frozen judge / blind comparison vs reviewed truth v2 on all axes,
   figure binding included; unknown fields stay excluded.
4. Parent adjudicates the subset-proof exemption vs one initial review of the
   fixed diff, then exact-head CI + merge. Merge is held meanwhile.

This draft is not completion of YUK-1404. Spend by this writer:
USD 0 / Credits 0 / OCR 0. No DB, container, provider, network, key or
deployment work; photos and truth stay outside git.
