# YUK-1323 model output compatibility

Owner instruction: "第十八条不算啥问题，可以放宽。第三十条需要优化我们的系统。"

Implementation starts from `d34445ee21ea3ce9a589bf5761b83272f11460f2` on the new local branch `fix/yuk-1323-model-output-compat`. That head retains final local closeout docs after merged PR #1571 (`fb5ee31d8`). Parent owns independent review, fresh model retest, delivery, PLAN/.remember and Linear. This lane makes no provider calls or admission changes.

## Evidence and required behavior

The immutable diagnostic directory is `/tmp/tlp-mimo-synthetic-d34445ee`. Its frozen corpus SHA-256 is `6c3c12eea5dbff55ff2ab6c1989892f32cc8c6b33efb058ccc2b856cfcb014b5`.

Saved synth-18 output from run `d5c33752-a694-486a-81a0-e4a972d03187` awards the correct zero. The original response contains background annotations and `final_answer.text`. The quote preserves that same key path and text value but drops the background object. Its reconstructed object is not a literal substring. `tests/fixtures/yuk1323-synth18.json` preserves the complete saved request and terminal text, including output SHA-256 `e164107570467d893ae81a0b61e8c7dd9070a11855dc462975647a6423161bbe`. The offline native executor test supplies a test-only admitted descriptor; the original diagnostic descriptor remains null and no model is admitted.

Synth-30 run `e76919c5-819b-4cf3-8e29-6c8fea56a312` left a Zod `unrecognized_keys` error for `evidence_citations` on pending. The temporary diagnostic parsed before saving terminal text. Its raw text and digest cannot be reconstructed. Pending regression inputs are explicitly synthetic reproducers of that observed error, not original synth-30 output.

## Changes and boundaries

`src/core/schema/assessment/evidence-quote.ts` is a pure boundary helper. It rejects empty or whitespace-only quotes, then keeps literal substring matching first. If that fails, both source and quote must parse as JSON. The quote must be an object projection containing at least one nonblank string, number or boolean. Every cited key must exist at the same original path and match its value and primitive type. Objects can omit uncited siblings. Arrays must retain their full length, order and object contents. Null-only and empty projections fail. All quoted leaves must match; one real leaf cannot justify fabricated surrounding context. There is no fuzzy or model-assisted comparison.

The supplemental JSON path also rejects numeric precision loss. The parser compares each number's decimal identity with its JavaScript round-trip identity before comparing leaves, so `9007199254740992` cannot justify `9007199254740993`, and `0.1` cannot justify `0.10000000000000001`. Equal lossless exponent/decimal notation remains valid. The native JSON reviver source context is available in the repository's Node 24 Docker runtime. Missing source context fails closed for numerical projections. Lossy numbers anywhere in the parsed document conservatively prevent the supplemental JSON path; the initial exact text path remains available.

Native execution applies the helper only to the same identified original response or byte-verified plaintext evidence previously used by citation validation. Slot/evidence membership checks, original asset checks, frozen rule/level/cap checks and missing-original rejection stay in place.

`AssessmentRuleDecision` explicitly permits optional typed pending `evidence_citations`, including an empty array. Each citation must name a slot or evidence attachment; malformed values and unknown citation fields fail. The pending object stays strict and forbids scoring/support fields. Native execution deliberately discards those diagnostic citations from its domain pending outcome, retaining the insufficient-evidence reason, run reference and cost. It cannot score or activate pending. The inline task prompt mirrors these shapes and the bounded JSON quote rule; the same schema remains both `structuredOutputSchema` and `outputSchema`.

Production `runTask` returns terminal text before domain parsing, and the native executor retains paid run identity/cost on validation failure. The proven capture-order defect is in the temporary diagnostic. This change adds no production output store, logging subsystem or reasoning capture.

## Temporary diagnostic repair

The corrected runner is `/tmp/yuk1323-model-compat/run.mjs`. It reads the original frozen corpus but writes only to the new directory. Terminal answer text and digest are saved to `terminal-<case>.json` before either parser runs. Failed result rows also retain the captured `result` and `outputDigest`. Citation validation uses the production helper. Original synth-30 missing output stays missing; a future run cannot replace that evidence.

`verify-capture.mjs` executes the actual copied collection block with synthetic parser failures at both parsing steps and checks that raw text/digest already exist. It makes no model/DB calls and stores no chain of thought. `capture-check.json` reports both cases passing and all 53 original artifact hashes unchanged. The corrected runner still needs the parent to verify a disposable database and authorize any new requests before execution.

## Verification and handoff

- Initial native boundary RED: 8 failed, 66 passed, including actual synth-18's incorrect pending result and the pending citation schema rejection. `/tmp/yuk1323-model-compat/red.log`.
- Supplemental numeric boundary RED: both distinct-number cases incorrectly scored before the precision safeguard. `/tmp/yuk1323-model-compat/numeric-red.log`.
- Final scoped unit tests: 136 passed, comprising 83 native executor cases and 53 task-catalog cases. Command: `pnpm vitest run --config vitest.unit.config.ts src/capabilities/practice/server/judge/pi-model-executor.unit.test.ts src/capabilities/task-catalog.unit.test.ts`. `/tmp/yuk1323-model-compat/unit-final.log`.
- `pnpm typecheck`: passed. `/tmp/yuk1323-model-compat/typecheck.log`.
- `CODEX_FULL_GATE=1 pnpm lint`: passed, zero errors and 297 existing warnings. `/tmp/yuk1323-model-compat/lint.log`.
- `CODEX_FULL_GATE=1 pnpm build`: passed for web, server, worker and migrate bundles. `/tmp/yuk1323-model-compat/build.log`.
- `git diff --check`: passed. No DB tests were needed for this pure output-boundary/schema/prompt change; DB persistence, activation and model quality were not exercised.
- Temporary runner syntax and offline capture checks pass. `/tmp/yuk1323-model-compat/capture-check.json` and `verify-capture.mjs`.

No database schema, migration, UI, activation policy or model admission changes. No full local `pnpm test`, push, PR, independent review, deployment or paid requests. No additional actionable follow-up was discovered outside YUK-1323's stated scope; parent owns its tracking capture and the already-required review/retest/delivery steps. External `.serena/project.yml` must remain unstaged and byte-identical to its initial SHA-256 `922f74785b417d114a6ba0b8969f0de7f96306ea6ff1d485eef9f27a3648e913`.
