# mastery-read-engine — architecture delivery

Refs YUK-1570. Partial delivery; keep issue In Progress.

Base: a519a05d2f70bc26747211740cfb04a43f32486f. Existing audit measured server 440 → 432. Cross value42 and SCC1×5 unchanged.

Complete row/ability reads and p(L)/KG projection computation moved into two kernel read models. Existing server exports preserve compatibility. Write paths/locks/transactions stay in state.ts. Eight capability consumers switch imports; parent reverted four unnecessary server consumer import edits.

Two maintenance cases: ability-global read fallback changes stay with the shared row-read engine; KG soft-layer read changes stay with the projection engine, without mixing writer logic. This is read-ownership separation, not a new algorithm. Remaining old consumers and public compatibility exports are explicit residuals.

Three audit:relations marker paths now follow the moved implementation; relation/marker/tier and audit semantics unchanged.

Child typecheck/lint/build passed; original implementation evidence `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/a519a05d2f70bc26747211740cfb04a43f32486f/mastery-read-engine/delivery.md`, SHA-256 `227f1ecc3d0e609788613ec6ec8e27f2742990616679b91f50e9d87424d73659`. Parent narrowed scope and registered measured baseline before independent R1; parent exact-head static checks are recorded separately, not inferred from child success.

Commands: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm audit:capability-boundaries`, `pnpm audit:architecture-deepening`, `pnpm audit:relations`.

NOT_RUN: local tests, DB, TEST, Docker, provider, runtime acceptance and deployment. No test code changes. Exact-head CI and independent review remain required before merge.
