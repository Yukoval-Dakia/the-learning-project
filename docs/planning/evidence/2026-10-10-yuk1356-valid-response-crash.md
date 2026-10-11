# YUK-1356 complete valid response before result-save crash

Controlled crash acceptance PASS on 2026-10-10. This closes the missing **controlled valid-response crash boundary** in scenario 12 of the [current acceptance matrix](../2026-10-09-yuk1356-current-acceptance-matrix.md). It does not close actual external model output, native Start, restore, deployment, or the whole judge migration. Parent owns integration and independent rerun.

## Scope and prepared state

Sole writer in `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1356-valid-response-crash`, branch `test/yuk-1356-valid-response-crash`. Initial status was clean. Verified prepared HEAD `d637a3d616a6fe88d834650f4d80ed1821c3d726`, normal merge parents `b3706b5dd9058f995fb95a4613d90e6ce1e9d481` and `e97fd22fe845993166cb0fa66366ab2abe4a1559`. Local `origin/main` had already moved to `081b64779a253efa076b964fa4b712cfc4704ac8`; no fetch, branch change or integration was performed.

Only `tests/dbos-judge/process.db.test.ts`, `tests/dbos-judge/worker.ts` and this note changed. `support.ts`, product sources, Start/boot, PLAN and remember remain unchanged. Existing review budget remains spent R1/R2; this acceptance implementation started no new review. No delegation, push, PR, merge, Linear update or deployment. No new actionable follow-up beyond the parent-owned acceptance obligations was discovered.

Runtime preflight confirmed Docker client/server 29.4.0, Node 24.19.0, pnpm 11.13.1, DBOS 5.2.11 and installed Pi 1.0.2. The parent granted an exclusive scoped DB-test window with OrbStack running and no maintenance hold. Each focused invocation used the existing Testcontainers setup to start a fresh `pgvector/pgvector:pg16` container, migrate it, and clone its isolated `test_fork_*` databases. Global teardown exited successfully. Only the disposable test database was reset. No shared app, worker or PostgreSQL was accessed, and no engine restart, pruning, restore or external provider call occurred.

## Exact crash boundary

Existing production observation hooks cover `claim-committed` and `result-committed`; the latter is too late. The fixture now intercepts only the real `experimental:assessment_model_result` INSERT for the selected scored rule in its existing postgres debug callback. It preserves the serialized production payload and IDs, reports them through IPC, then synchronously SIGSTOPs the process. The parent waits for that IPC and polls `ps` for state `T` before inspecting rows and issuing SIGKILL. It never waits an arbitrary time to infer that the boundary was reached.

This proves completed validation independently of network drain. The real [Pi model executor](../../../src/server/assessment/pi-model-executor.ts) first parses `AssessmentRuleDecision`, checks original citations, frozen rule identity, points and cost caps, and returns `kind: scored`. The real [recorded model executor](../../../src/capabilities/practice/server/judge/recorded-model-executor.ts) parses `ModelUnitOutcome` before calling `writeEvent` for the result. The installed postgres `connection.js` executes `build(q)` before `write(toBuffer(q))`, and calls the debug callback inside `build`. At the pause, the actual SQL result payload is therefore already validated, while its INSERT has not been sent. A second connection confirms the exact result ID is absent before SIGKILL and again after child exit.

The child also drains an independent clone of the elimination response, preserving its complete HTTP200 SSE body including the stop/usage chunk and `[DONE]`. The installed Pi driver consumes the original response unchanged. The existing egress guard still rejects every fetch outside the owned loopback origin. Failure-case transport observation behavior is unchanged.

## Observed final run

- Permanent run `judge_native_sub_aawv2861ntj2nockr7blg8tw`. Reopened workflow `judge-run-v1:judge_native_sub_aawv2861ntj2nockr7blg8tw:delivery:0`.
- First PID 56896 was stopped with state `T`, then exited with code null/signal SIGKILL. Second PID 56903 recovered the same workflow and exited 0. DBOS status SUCCESS; domain status remains `review_required`.
- Exactly two independent wire requests, one equations and one elimination. Reopen added no request, claim or task run. Third unit remained unclaimed and unpaid.
- Two permanent claims and one result existed before death. The first scored result survived byte-for-byte; the second result remained absent even after recovery. The held candidate has first score 1, unknown second and blocked third, with no points or matched rule fabricated for either pending unit.
- All original pending/dispatch receipts, complete submission rows, frozen revision rows and complete task-run rows are unchanged after recovery. Effective head stayed null/generation 0 and no FSRS settlement was written. Task transport success is retained as task evidence; it is not promoted into a missing assessment result.

| Unit | Operation suffix for claim/result/task IDs | Claim input digest | Task input hash |
| --- | --- | --- | --- |
| equations | `4932b105684acaf9683cc70df7e7372bad833bfc3bf9b6666731ce60cbd914df` | `785cf8f6239d58a505ae28c038dcb8ea3e307c162c92148cd7ce2214a0282138` | `4aad7ea3420753331527cc909696d76ccfad9c8d3f6d485db02bd3fa14e2f955` |
| elimination | `81e42e44d51eb201567c4816ca280823f054ee5dabcd79f93a095a4a8dfcb8fd` | `d202b8f187ff655248895a49f558d453dce82aae80dc73e1f9a2f63c7e568942` | `cda704d78f0cfae282449688610da07c7056042f7bfec0b1aef0bffb1a82e4ed` |

The exact IDs use `evt_model_claim_`, `evt_model_result_` and `assessment_` prefixes with the operation suffix above. Both tasks are `openai/gpt-4.1-mini`, success/end_turn, with estimated catalog cost. Both existing `ai_task_runs.result_digest` values are null and remain null; no digest is fabricated in those rows.

Validated elimination outcome canonical digest `a740651b05f1389344f0ac726c8dcb19be79dd62b9dc832790482f506a457f47`. Complete received SSE response SHA256 `58b1e230a0f60eafa5ff465419d72dfafdc4bd53d70b2e81bdf14342cab5efbc`. These are distinct evidence digests.

## Commands and retained logs

All pnpm commands ran inside this worktree through `bash /tmp/yuk1359-offline-env.sh`, which clears unrelated environment and selects the frozen Node/pnpm installation. No full `pnpm test` or other DB test was run.

```bash
bash /tmp/yuk1359-offline-env.sh pnpm install --frozen-lockfile --offline
bash /tmp/yuk1359-offline-env.sh pnpm vitest run --config vitest.db.config.ts tests/dbos-judge/process.db.test.ts -t '^complete valid response validated before result save survives SIGKILL and same-workflow reopen without repurchase$'
bash /tmp/yuk1359-offline-env.sh pnpm typecheck
bash /tmp/yuk1359-offline-env.sh pnpm lint
bash /tmp/yuk1359-offline-env.sh pnpm build
bash /tmp/yuk1359-offline-env.sh node /tmp/yuk1356-valid-response-verify.cjs
```

The final focused run passed 1 test with 14 existing cases skipped, duration 11.73s, test 5.471s. Earlier runs 01 and 02 also passed only the new case. Initial typecheck failed because the test had not narrowed the parsed rule/pending union; explicit narrowing repaired it. Final source uses the actual child Node version rather than a hardcoded patch-version assertion. Final typecheck, lint and all build targets exit 0. `git diff --check` passes.

| Check | Exit | Log | SHA256 |
| --- | --- | --- | --- |
| Frozen offline install | 0 | [yuk1356-valid-response-install.log](/tmp/yuk1356-valid-response-install.log) | `f682aba26d13c393a60a72afb3ada163244585f1dee01ec67fa5f74c3bf370f0` |
| Focused process run 01 | 0 | [yuk1356-valid-response-process-01.log](/tmp/yuk1356-valid-response-process-01.log) | `41e168349d7022b22cd675548e9c04958d45c4ce14a4bd161d2c4a8a6c48182d` |
| Initial typecheck, missing test union narrowing | 1 | [yuk1356-valid-response-typecheck.log](/tmp/yuk1356-valid-response-typecheck.log) | `d0a58cff1c3649b969398be8314baa784c42392947da5408331bae371d0c4559` |
| Focused process run 02 | 0 | [yuk1356-valid-response-process-02.log](/tmp/yuk1356-valid-response-process-02.log) | `57cb7406c79d023139f41afdda13168f97d499b2375a62f350f9ab4394d219d1` |
| Final focused process run 03 | 0 | [yuk1356-valid-response-process-03.log](/tmp/yuk1356-valid-response-process-03.log) | `f52e31dde078cfa957167783ccd135fb2c63ae00b089000815a6f9df3a2da3ac` |
| Final root and Start typecheck | 0 | [yuk1356-valid-response-typecheck-final.log](/tmp/yuk1356-valid-response-typecheck-final.log) | `36ea241c6942f1a41abb39db13194e6117c19022d769f9059b8a87960ef20ad6` |
| Final repository lint, 172 warnings | 0 | [yuk1356-valid-response-lint-final.log](/tmp/yuk1356-valid-response-lint-final.log) | `23484c1e3379921f24e563423be2ac2781f89b7bf64300028faa9dc9d828a730` |
| Final web, Start, API, worker, migrate build | 0 | [yuk1356-valid-response-build-final.log](/tmp/yuk1356-valid-response-build-final.log) | `551c503bb572a9b642c64564cedd2145c5c391eeb161aa2a167f97e88cbf4526` |
| Source and evidence verification | 0 | [yuk1356-valid-response-verification.log](/tmp/yuk1356-valid-response-verification.log) | `44b115cd269184c4854d80f3dd745d459edfb34e28ee01e358f7e8316306d8a8` |

## Evidence and preservation

- [Final process evidence](/tmp/yuk1356-valid-response-process-03-evidence.json), SHA256 `7728b5879e997ea6f0eb54f22a85e2c8968b7080e1c3d032525da3233f980347`. It contains before-save, after-kill-before-reopen and after-reopen DB snapshots, full frozen evidence, task rows, actual response, wire observations, source/package hashes and child IPC/exit logs. The original ignored output is `.cache/yuk1356-judge-process-evidence.json`.
- [Verification report](/tmp/yuk1356-valid-response-verification.json), SHA256 `44b115cd269184c4854d80f3dd745d459edfb34e28ee01e358f7e8316306d8a8`. All 13 recorded source/dependency hashes match current files. The scratch verifier SHA256 is `fa62fc68ba0aaf7affff4c5730c193ae4e665ef19b4de5fd5c443c34cfe1db1f`.
- TypeScript AST extraction compares each original callback text with the prepared commit. All 8 callbacks, covering the 14 existing expanded tests, remain byte-for-byte identical; exactly one callback was added. No old assertion was removed or weakened. Those old cases were not executed in this task.
- [Executable binary diff](/tmp/yuk1356-valid-response-executable.patch), SHA256 `64095d4ded116339a61ada2b953d77e90741242b1ee47e7ce1a495d1a8e8af92`. It includes only the two test fixture files.
- Earlier source-specific evidence remains separately copied at `/tmp/yuk1356-valid-response-process-01-evidence.json` and `...-02-evidence.json`; the original typecheck failure log is retained.

No production hook addition was needed. This acceptance does not retry or alter the original unknown HTTP429 paid identity, and makes no claim of successful external provider output, exact-head CI, deployment, coherent restore or whole migration completion. Parent must rerun the committed artifact before integrating it.
