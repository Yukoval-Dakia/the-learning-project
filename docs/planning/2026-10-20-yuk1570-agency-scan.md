# Agency proposal scan operation

Refs YUK-1570. Partial architecture delivery, issue remains In Progress.

Dreaming and coach jobs duplicated the scan's inbox-before/after diff, trigger/result events, runtime tool mount, context/proposal budget gates and failure rethrow. One capability-owned operation now owns that sequence. Consumers keep signal input assembly and their actual differing output hooks. Existing exports and injected runner/clock/event/inbox seams remain compatible; central AI/provider modules are unchanged.

Two maintenance cases: a scan budget-gate change now has one implementation instead of parallel job edits; trigger/failure provenance envelope changes are centralized while TodayPlan and note-refine policies remain with their jobs. The shared scan is real operation ownership; the proposed research runner-binding helper was only a forwarding wrapper and the parent reverted both research and ai-runtime files before R1.

Base a519a05d2f70bc26747211740cfb04a43f32486f. Parent existing-audit snapshot measured agency→ai28→25, capability→server440→437; cross42 and SCC1×5 unchanged. Baseline only registers measurements; no audit/CI changes.

Original child source c65af637a had an extra one-edge wrapper reduction, which is not in this patch. Original child typecheck/lint/build passed, evidence `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/a519a05d2f70bc26747211740cfb04a43f32486f/agency-ai-operation/delivery.md`, SHA256 `8e61bf07dae32b4f7690bc9feee08afa752b4fd3a513a2be14a520529620bdbd`. Parent checks on the narrowed exact head run separately. Commands: pnpm typecheck/lint/build, pnpm audit:capability-boundaries, pnpm audit:architecture-deepening, pnpm audit:task-census. Independent R1 and exact CI pending.

NOT_RUN: tests, DB, TEST, Docker, provider, runtime acceptance, deployment. No test code changed. #1802's two dreaming comments will be adapted by its later merge owner; no unmerged tool strategy was adopted here.

Parent integration caught and corrected input assembly being moved before the trigger event: signal reads remain before trigger, while the returned pure input builder executes at the original runner-call position inside try/catch, preserving failure evidence and rethrow. This fix precedes the initial independent review.

Ordinary main integration 0f722b0734a6999e59ad4c96e8c49cbe746f338c: all 3 lane source files byte-identical to reviewed 85bec628ab2ea7aa01a22c126d49df4bda8d13ee; unchanged module imports/initializers. Existing audit recomputed server432→429 (agency→ai28→25), cross42/SCC1×5 unchanged; both decrease notes retained. The first-head db3 authorized single rerun passed (run39407051799 attempt2, Gate118586286060), receipt SHA4388a6c9d48de7534a51356da4aa75bb4bcf34d2b0da92d6d118aa5d96de1440, external architecture-deepening/YUK-1570/85bec628ab2ea7aa01a22c126d49df4bda8d13ee/ci-db3-118575418598/single-rerun-success-receipt.json. New head requires fresh checks/CI; source R1 remains applicable, no new review round. Coordinator clarified one conditional retry per exact head, only same 08006/exit1/noIPC signature plus unchanged import-time execution; record each first failure log SHA in YUK-1481, second red on that head stops. No tests or gate changes.

Supply-main composition: ordinary merge of 4fd179818bd4a3ad8f16c07b2c9f38daa1adc259; 3 PR source files remain byte-identical to reviewed 85bec628ab2ea7aa01a22c126d49df4bda8d13ee. Existing audit: server429→426, cross42→42. 按 10-20 协调线基线整合等待窗解释：仅main带入内容及baseline/记录变更，等新head本地检查/exactCI及已有findings裁决；等待窗沿用最后一次本片产品/测试源码push，不免除任何新P0/P1裁决。
