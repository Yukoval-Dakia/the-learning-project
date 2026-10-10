# YUK-1356 controlled process transport diagnostics

This implementation lane corrects a proven test fixture protocol mismatch. Real DBOS process acceptance is **prepared, UNRUN** at this revision. The exact exception from the original zero-wire run was not retained, so the mismatch is not claimed as a runtime-confirmed explanation of that exception. Product sources remain unchanged. R1 was already consumed; the parent retains R2 and all runtime acceptance.

## Original failure retained

Base is `1535cf60c621e53e76384bc4956165b673e8ad83` on `feat/yuk-1356-durable-judge`. Parent inputs remain at `/tmp/yuk1356-parent-process-db/process.log` and `process-evidence.json`. Their SHA-256 values are recorded in `/tmp/yuk1356-process-wire-diagnostics/original-input-hashes.json`. Sanitized copies preserve the original assertion failure, permanent receipts and worker logs. The original fixture sources and bundled worker match all three corresponding hashes in the parent's evidence. The original bundle SHA-256 is `1f5b0fa1a48395f44939ba00c5e275d4f9df018663298431751836fab7a1a407`.

The actual first case, `SIGKILL/reopen through production worker at native-load-committed`, failed with expected wire count 3 and actual 0. The reopened worker reported recovery of one workflow and emitted a `model_profile_resolved` record for `AssessmentRuleJudgeTask`, provider `openai`, model `gpt-4.1-mini`, adapter `pi`. Its planned task run was `assessment_32cee01407b8b0b247db670f978efcba42e0242cec5bc4f23cafa17de532184e`.

The permanent result was `resolved` with domain status `review_required`. The first unit retained an `assessment_model_claim` and a pending `assessment_model_result` with reason `infra_failure` and detail `native model asset, execution or output validation failed`. The remaining units were held because the first unit had an unknown or held result. The supplied evidence has no `ai_task_runs.error_message`, original thrown error or cause chain, and no pre-parse HTTP arrival count. Zero validated wire requests alone does not distinguish failure before HTTP from a request rejected by the observer's payload parser.

## Source findings and correction

- Original `tests/dbos-judge/worker.ts:45-58` constructed `builtinModels()` and overwrote only `getModel()`. The returned model said `openai-completions` and pointed at the loopback observer.
- Installed Pi 1.0.2 `node_modules/@earendil-works/pi-ai/dist/models.js:457-462` resolves the registered provider and calls that provider's `streamSimple`. `models.js:556-564` selects a provider's single API implementation independently of `model.api`.
- Installed `node_modules/@earendil-works/pi-ai/dist/providers/openai.js:6-21` registers the OpenAI Responses API. `dist/api/openai-responses.js:133` calls `client.responses.create`. That registration remained active in the old fixture despite its Completions model and Chat Completions SSE observer.
- The production adapter uses the injected collection's `getModel` at `src/server/ai/pi-agent-adapter.ts:1478` and `streamSimple` at `:1018-1031`. The fixture therefore changed model lookup without changing the actual provider transport.
- `src/server/ai/runner.ts:918-942` binds and settles started task failures. `src/server/ai/run-lifecycle.ts:598-606` retains the error message, while `src/server/assessment/pi-model-executor.ts:274-300` converts execution/output failures into the generic domain pending result seen in the original evidence. Those product paths were read only.

Corrected `tests/dbos-judge/worker.ts:58-67` uses installed `createProvider`, `envApiKeyAuth` and lazy `openAICompletionsApi`, then registers that provider with the existing collection. The controlled model, endpoint, budgets and cost settings are unchanged. The production adapter, installed agent loop and Pi HTTP/SSE implementation remain real. The existing same-origin fetch guard remains at `worker.ts:68-79`. No recorded result executor or fake Pi stream was added.

`tests/dbos-judge/process.db.test.ts:36-65` now counts loopback HTTP arrivals independently of successful frozen-input parsing, retaining only route category, method, time, body digest and a bounded sanitized error. `:173-210` projects task runs only for IDs from the actual model claims, including status, finish reason, usage/cost truth, times and a sanitized error message capped at 4096 characters. Worker stdout/stderr are sanitized when evidence is written. The original wire count, receipts, replay, candidate and settlement assertions are unchanged, as are fixed inputs and output schema.

## Offline evidence

Node was `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin/node`, version 24.19.0. Installed Vitest was 4.1.10, Vite 8.2.1 and esbuild 0.28.2. No install, environment/dependency change or service entrypoint execution was performed.

`tests/dbos-judge/transport-fixture.unit.test.ts` extracts only the worker's catalog setup using the installed TypeScript parser. It executes that isolated setup with real installed catalog/provider factories and the actual lazy Completions API factory. It does not import the worker, resolve authentication, invoke a provider stream or make HTTP requests. It checks agreement between adapter lookup and registered catalog, local endpoint, exact Completions API registration, native key-auth implementation and an untouched provider.

Both offline tests failed against the original worker and both passed against the corrected worker. `unit-red-vitest.log` and `unit-green-vitest.log` retain the results. A temporary ignored config, `.cache/yuk1356-process-wire-unit.config.ts`, narrows the existing unit config to this test. No repository test configuration changed.

Root `tsc --noEmit` and scoped Biome passed. The separate `tsc --noEmit -p server/start/tsconfig.json` failed with 91 diagnostics in unchanged Start files, including `server/start/admin-client.ts:24` and `server/start/admin-function.ts:36`. Its dependency listing and summary are sealed separately; the owned test fixtures are absent from that graph. This lane does not claim the complete typecheck gate passed and does not modify those unowned files.

The fixture bundled successfully with the acceptance suite's existing esbuild arguments. All five product build steps also passed: web, Start, server, worker and migrate. Vite ran explicitly through Node 24; esbuild used the package scripts' Node 24 target. `build-results.json` records the effective commands and exit codes. No generated bundle was executed.

## Parent acceptance and ownership

The parent must run the unchanged first SIGKILL/reopen case under its runtime mutex, inspect `transport`, `taskRuns` and the permanent receipts, then complete the remaining process acceptance. A pass in this offline lane does not establish DBOS recovery, actual wire counts, settlement or provider acceptance. If a new product exception appears, its exact persisted message and source path must be handed back before any product fix. No product defect is established by this source-only correction.

Sources, sanitized logs, original-input hashes and current/copied build hashes are sealed in `/tmp/yuk1356-process-wire-diagnostics/`; the final commit and manifest verification are recorded in `HANDOFF.md`. No DB, Testcontainers, Docker, provider, browser, service, migration/runtime entrypoint, git fetch/switch/merge/push, PR, Linear or child/review work ran in this lane. The parent retains tracker capture for the unresolved acceptance and Start gate failure. No duplicate product follow-up was opened for the corrected fixture.

Writer RELEASED / noPending after the final owned-scope commit and handoff.
