# YUK-1007 — Native pi providers

Owner decision (2026-10-03): migrate the old compatibility routes immediately,
then remove them. Provider/model switching must select the actual pi preset,
including API, compat flags, auth and headers. No parallel legacy execution route.

## Implementation

- `createLoomPiModels` returns native `builtinModels()` without overriding Xiaomi
  or creating Zhipu/Anthropic-compatible models from the models.dev snapshot.
- Xiaomi keeps its canonical name and key, now uses native OpenAI Completions.
  Native MiMo Pro is text-only; the three remaining multimodal conjecture-task defaults migrate to MiMo-V2.5;
  existing judge/ingestion vision defaults already use it.
- `zhipu` is removed as a runnable provider. `zai-coding-cn` is canonical, with
  `ZAI_CODING_CN_API_KEY`. GLM5.2 is absent from pi1.0.1; active DB configurations
  migrate to GLM5.3 (default proposed to owner; alternative Flash remains selectable).
- `anthropic-sub` remains an authentication lane; adapter and nested agents resolve
  its models in native `anthropic`, preserving native compatibility flags and OAuth.
- Config writes check native model membership and task capability. Provider-only
  changes/clears cannot leave a model on the wrong preset. Invalid restored task
  providers fail clearly instead of silently selecting the task default.
- Admin providers expose `pi_provider` and native `models[{id,api,input}]`, never keys.
  Synchronous metadata is generated offline by `scripts/gen-pi-provider-catalog.ts`;
  a test compares every row to the installed pi registry. Execution uses pi itself.
- SQL0113 updates active config only, appends journal revisions and advances epoch.
  Model/profile/run history stays unchanged. Policy collisions and other retired Zhipu model IDs abort atomically with actionable
  key/model diagnostics; their replacements must be selected explicitly.

## Operator migration at deployment

No deployment or production configuration has been performed in this task.
Before deploying, change any AI provider env pins from `zhipu` to `zai-coding-cn`,
change GLM5.2 model pins to GLM5.3, and expose the existing coding-plan credential
under `ZAI_CODING_CN_API_KEY` to both app and worker. `ZHIPU_API_KEY` remains for
independent OCR/memory consumers. Rename the key of any env JSON session-admission
policy too; reconcile collisions before applying SQL0113. Do not rewrite historical
runs. Drain or explicitly cancel pending legacy-provider jobs before deployment;
restored legacy task config fails visibly until migrated. A global MiMo Pro pin is
text-only: use native MiMo-V2.5 for an image-capable global pin. SQL migration is transactional and idempotent, and does not edit env secrets.

## Validation

Native Xiaomi/Z.AI/OpenCode Go real-driver local HTTP fixtures cover two-request
agent tool loops, system/skill/tool replay, UA/session headers and usage. Catalog
parity checks all implemented providers and all chat task defaults. Postgres tests
cover pair validation, atomic rollback, old config migration, unchanged history,
stale epoch advancement, policy collisions and idempotency.

Earlier authorized opencode-go probe on main d58a9614/pi1.0.1 used two actual remote
requests, both200, a local verify_roots tool and final answer, correct native UA/session.
Estimate0.0001601USD is catalog cost, not billing. Adapter-only, durable_task_run_id=null.
No new paid call is claimed by the native migration tests; Xiaomi/Z.AI fixtures do
not establish production access or model-output quality. No UI completion claim.

Independent initial review found two P1s (stronger-provider precedence; retired legacy
model IDs) and three P2s (typed default reset, model-only writes under global pins,
migration lock ordering). Two P1s and two P2s were fixed in4e18fec3. The single
verification review confirmed no remaining P0/P1 but identified an uncovered env/DB
branch in the global model-only fix.

Advisory review subsequently found a global-pin P1: a catalog-valid text-only global
model would disable every multimodal task. The author fix validates each affected chat
TaskSpec using the in-transaction model rows; typed tasks are excluded. It also shares
the actual global selection resolver with runtime, fixing the remaining P2: an env
provider selects the whole env pair and never borrows a DB global model. Tests cover
atomic rollback, per-task model fallback, compatible native OpenCode Go, typed isolation,
and actual runtime resolution under mixed env/DB state. No third independent review.

Local baseline:339 unit tests across13 files,52 config/HTTP/DB tests,61 Copilot DB tests,
81 migration smoke tests, typecheck/lint/build/all pre-PR audits passed. The global-pin
fix adds4 DB regressions (56 configuration tests total, all passed), with73 related
unit tests passing; final results and exact-head CI
are recorded in the PR. CI37128248936 passed forf8663e29 before the advisory fix.
Final-push17-minute window restarts after the corrective push.
