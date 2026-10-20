# Agency proposal scan operation

Refs YUK-1570. Partial architecture delivery, issue remains In Progress.

Dreaming and coach jobs duplicated the scan's inbox-before/after diff, trigger/result events, runtime tool mount, context/proposal budget gates and failure rethrow. One capability-owned operation now owns that sequence. Consumers keep signal input assembly and their actual differing output hooks. Existing exports and injected runner/clock/event/inbox seams remain compatible; central AI/provider modules are unchanged.

Two maintenance cases: a scan budget-gate change now has one implementation instead of parallel job edits; trigger/failure provenance envelope changes are centralized while TodayPlan and note-refine policies remain with their jobs. The shared scan is real operation ownership; the proposed research runner-binding helper was only a forwarding wrapper and the parent reverted both research and ai-runtime files before R1.

Base a519a05d2f70bc26747211740cfb04a43f32486f. Parent existing-audit snapshot measured agency→ai28→25, capability→server440→437; cross42 and SCC1×5 unchanged. Baseline only registers measurements; no audit/CI changes.

Original child source c65af637a had an extra one-edge wrapper reduction, which is not in this patch. Original child typecheck/lint/build passed, evidence `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/a519a05d2f70bc26747211740cfb04a43f32486f/agency-ai-operation/delivery.md`, SHA256 `8e61bf07dae32b4f7690bc9feee08afa752b4fd3a513a2be14a520529620bdbd`. Parent checks on the narrowed exact head run separately. Commands: pnpm typecheck/lint/build, pnpm audit:capability-boundaries, pnpm audit:architecture-deepening, pnpm audit:task-census. Independent R1 and exact CI pending.

NOT_RUN: tests, DB, TEST, Docker, provider, runtime acceptance, deployment. No test code changed. #1802's two dreaming comments will be adapted by its later merge owner; no unmerged tool strategy was adopted here.
