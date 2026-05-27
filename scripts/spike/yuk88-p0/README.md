# YUK-88 P0 TipTap Spike

Spike-only package for YUK-90. It validates the ADR-0020 block-tree assumptions without touching production `src/` code or the root package.

Run:

```bash
cd scripts/spike/yuk88-p0
pnpm install
pnpm spike
```

`pnpm spike` writes `snapshots.json` with:

- TipTap/ProseMirror JSON round-trip from `fixture.json`
- split `b_def_1` -> `b_def_1` + `b_def_new`
- merge `b_def_1` + `b_def_new` -> `b_def_1`
- `mark_wrong` projection staying on the original block id
- idle coordination mock: defer while editing, flush on idle, force flush on timeout

Spike conclusion:

- PM `doc.toJSON()` shape is viable for `body_blocks`.
- Notion-style mark anchors work if split keeps the left block `attrs.id` and only mints a new id for the right block.
- ADR-0020/P2 should explicitly require split command wrappers to preserve the left block id; relying on generic PM split semantics without an id policy is too implicit.
- Idle coordination can be modeled as client presence plus server patch queue flush; production P4 still needs real race/concurrency handling.
