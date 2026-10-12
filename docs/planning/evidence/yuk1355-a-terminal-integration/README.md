# Terminal-job repair integration

Normal merge of fixed `2a28118b5c96df4ef6e23032e14bb2942ae226f2` onto parent
`0c8007ac3`. Git retained the earlier adapter move into Practice. Three import
conflicts were resolved using the fixed repair and the established core/db/public
paths. New request schemas, identity error and job reader are exported through
Practice's public boundary. No repair function body or test assertion changed.

Parent comparison against the original fixed repair passes **127/127 declaration
ASTs**. The comparator ignores imports, export wrappers and parser metadata;
it does not normalize implementation bodies. Prior boundary and C evidence
remain untouched. Capability boundary audit remains **428/0/48**, with no
baseline or auditor change. Parent typecheck passed.

All 28 A DB cases remain prepared and unrun. They include the 15 earlier adapter
cases and 13 terminal-job recovery/cancellation-race cases. The prior R2 found
the terminal-job P1; this is its targeted repair, not a third review. A separate
coordinated DB window is required. DB07's three C passes and DB05's 34 shared
passes do not establish A acceptance.

No runtime cutover, registration, provider call or TEST mutation is included.
Existing A census/partition and public-export cycle follow-ups remain open;
this merge does not claim all static audits pass.
