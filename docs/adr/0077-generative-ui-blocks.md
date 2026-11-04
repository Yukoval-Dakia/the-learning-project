# ADR-0077: Generative UI block family (tlp-block)

Status: Accepted (slice 1, YUK-1548)
Date: 2026-11-03

## Context

Chat replies, notes and question materials need one way to carry
model-generated visuals (flowcharts, apparatus figures, charts, formulas,
interactive cards). The full design and the per-surface lifecycle live in
`tlp-docs/design/2026-11-03-yuk1548-generative-ui.md`; this ADR records only
the load-bearing repo decisions and what they supersede.

## Decision

- One stored format: a fenced code block with info string `tlp-block` carrying
  one JSON member of the `BlockV1` union (`src/core/schema/blocks/`). The same
  bytes appear in chat `reply_md`, note `codeBlock` bodies, and material
  `content_md`.
- `compose_block` is the mandatory write path: validate → typed issues
  (`{code,path,detail,line?,column?,expected?}`) → write-once
  content-addressed assets (`svf_` SVG figures, later `sbh_` sandbox HTML) →
  draft placement via `![alt](block:<ref>)`, substituted into canonical fences
  at reply commit by the reply finalizer.
- Mermaid 12 + jsdom are lazy dynamic imports, exact-pinned, bundled into the
  worker but marked external in `build:migrate`. Our own lint rejects `click`,
  `%%{` directives, `href`/`callback`, `url()` in style/classDef and raw `<`.
- Figure SVG is re-serialized from an element/attribute allowlist (saxes);
  anything outside the allowlist is a typed issue, never silently dropped.
  Stored bytes serve as `image/svg+xml` only for `svf_` rows written by the
  svg_figure profile; the UI shows them through `<img>` only.
- `compose_block` is `mirrorEvent:'never'` (the asset is the record; large
  payloads stay out of mirrors). `block_draft`/`block_ready` run frames carry
  progressive skeleton state; `block_draft` is latest-wins per `tool_use_id`
  and never carries partial SVG/HTML.
- Each figure returns a PNG raster to the model via the existing
  `output.images` tool-image channel (SVG→PNG in the DomainTool bridge).
- The legacy `<!--primary_view:-->` marker parse path (`extractPrimaryView`)
  is deleted; `present_primary_view` remains the only nomination channel.

## Supersedes

- **ADR-0033** (sandboxed HTML artifact / `ephemeral_html` presentation
  path): superseded as the carrier for structured visuals — generated
  diagrams and figures now live in `tlp-block` blocks bound to the tool
  trace. `ephemeral_html` remains for the interactive sandbox path until
  slice 4 migrates it to `interactive` blocks + `sbh_` assets.
- **ADR-0061** (copilot presentation intent control): superseded for block
  carriers — progressive `block_draft`/`block_ready` frames and commit-time
  fence substitution replace marker-in-prose presentation of generated
  visuals. Its server-validated nomination protocol (trace binding,
  artifact/ownership checks) is retained unchanged for hero selection.

## Consequences

- Slice 1 ships `diagram` + `figure` on the `chat` surface; `chart`,
  `interactive`, `question_ref` are in the union but return typed
  `kind_not_allowed_on_surface` until their slices land.
- Worker bundle grows ~15–21 MB (mermaid + jsdom + katex), evaluated only on
  first `compose_block` diagram/figure call; migrate bundle excludes both.
- Figure assets are write-once/content-addressed; unreferenced assets from
  failed runs are retained as evidence (no compensation delete).

## Known limitations

- The lazy jsdom/mermaid install writes browser globals (`window`,
  `document`, `navigator`, …) onto the worker's `globalThis`, where they are
  process-global for the life of the process. A `worker_threads` isolation
  lane was considered and deferred; if a second consumer of globals emerges
  or isolation evidence is required, revisit before widening mermaid use.
