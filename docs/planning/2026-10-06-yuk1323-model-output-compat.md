# YUK-1323 model output compatibility

Owner instruction: "第十八条不算啥问题，可以放宽。第三十条需要优化我们的系统。"

Implementation starts from `d34445ee21ea3ce9a589bf5761b83272f11460f2` on the new local branch `fix/yuk-1323-model-output-compat`. That head retains final local closeout docs after merged PR #1571 (`fb5ee31d8`). Parent owns independent review, fresh model retest, delivery, PLAN/.remember and Linear. This lane makes no provider calls or admission changes.

## Evidence and required behavior

The immutable diagnostic directory is `/tmp/tlp-mimo-synthetic-d34445ee`. Its frozen corpus SHA-256 is `6c3c12eea5dbff55ff2ab6c1989892f32cc8c6b33efb058ccc2b856cfcb014b5`.

Saved synth-18 output from run `d5c33752-a694-486a-81a0-e4a972d03187` awards the correct zero. The original response contains background annotations and `final_answer.text`. The quote preserves that same key path and text value but drops the background object. Its reconstructed object is not a literal substring. `tests/fixtures/yuk1323-synth18.json` preserves the complete saved request and terminal text, including output SHA-256 `e164107570467d893ae81a0b61e8c7dd9070a11855dc462975647a6423161bbe`. The offline native executor test supplies a test-only admitted descriptor; the original diagnostic descriptor remains null and no model is admitted.

Synth-30 run `e76919c5-819b-4cf3-8e29-6c8fea56a312` left a Zod `unrecognized_keys` error for `evidence_citations` on pending. The temporary diagnostic parsed before saving terminal text. Its raw text and digest cannot be reconstructed. Pending regression inputs are explicitly synthetic reproducers of that observed error, not original synth-30 output.

## Changes and boundaries

`src/core/schema/assessment/evidence-quote.ts` is a pure boundary helper. It rejects empty or whitespace-only quotes, then keeps literal substring matching first. If that fails, both source and quote must parse as JSON. The quote must be an object projection containing at least one nonblank string, number or boolean. Every cited key must exist at the same original path and match its value and primitive type. Objects can omit uncited siblings. Arrays must retain their full length, order and object contents. Null-only and empty-only projections fail. An empty object can match only an empty object at the same original path, with meaningful content elsewhere in the quote. All quoted leaves must match; one real leaf cannot justify fabricated surrounding context. There is no fuzzy or model-assisted comparison.

Before parsing either complete document, the supplemental JSON path scans raw members. An iterative object/array stack keeps a separate key set for each object. The scanner skips complete string tokens and escape pairs, and decodes each key with the native JSON string parser. Duplicate decoded keys, including differently escaped spellings, fail before `JSON.parse` can overwrite a member. The scanner also rejects keys named `__proto__`, `constructor` or `prototype`; this prevents `z.json()` from dropping `__proto__` before comparison. The complete native parser still validates JSON grammar, and the existing numerical reviver still validates precision. This adds no dependency or general parsing framework. Unsafe members anywhere in source or quote conservatively block the supplemental path, while literal substring quotes retain the original behavior.

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
- Pre-review scoped unit tests: 136 passed, comprising 83 native executor cases and 53 task-catalog cases. Command: `pnpm vitest run --config vitest.unit.config.ts src/capabilities/practice/server/judge/pi-model-executor.unit.test.ts src/capabilities/task-catalog.unit.test.ts`. `/tmp/yuk1323-model-compat/unit-final.log`.
- `pnpm typecheck`: passed. `/tmp/yuk1323-model-compat/typecheck.log`.
- `CODEX_FULL_GATE=1 pnpm lint`: passed, zero errors and 297 existing warnings. `/tmp/yuk1323-model-compat/lint.log`.
- `CODEX_FULL_GATE=1 pnpm build`: passed for web, server, worker and migrate bundles. `/tmp/yuk1323-model-compat/build.log`.
- `git diff --check`: passed. No DB tests were needed for this pure output-boundary/schema/prompt change; DB persistence, activation and model quality were not exercised.
- Temporary runner syntax and offline capture checks pass. `/tmp/yuk1323-model-compat/capture-check.json` and `verify-capture.mjs`.

No database schema, migration, UI, activation policy or model admission changes. No full local `pnpm test`, push, PR, independent review, deployment or paid requests. No additional actionable follow-up was discovered outside YUK-1323's stated scope; parent owns its tracking capture and the already-required review/retest/delivery steps. External `.serena/project.yml` must remain unstaged and byte-identical to its initial SHA-256 `922f74785b417d114a6ba0b8969f0de7f96306ea6ff1d485eef9f27a3648e913`.

## Initial review repair

Repair starts from `a361026b00e3478d3df028d73bcbe3d927f530c3`. The two P1 reproducers incorrectly scored 5 against `{"background":"ungraded","final_answer":{"text":"v=12"}}`: a quote containing duplicate `text` members `v=15` then `v=12`, and a quote adding `__proto__.text = v=15`. Both were reconstructed quotes outside the original substring path. Native parsing lost the first duplicate, and Zod lost the prototype member, before comparison. Both losses are now rejected at the raw member check.

Evidence is separate from the ongoing parent's real model retest, in `/tmp/yuk1323-quote-review-fix-20261006`:

- `duplicate-red.log`: 8 failed, 83 passed through the actual native executor. Source and quote failures cover root/nested members, Unicode-escaped duplicate keys and object members inside arrays. Every reproducer asserts it is not an original substring. `duplicate-green.log`: 91 passed after the scanner.
- `prototype-red.log`: 8 failed, 91 passed. Source/quote, nested/array and escaped prototype member cases incorrectly scored before the special-key check. `prototype-green.log`: 99 passed after the check. Rejected outcomes retain `run-native` and cost 4000.
- `empty-object-red.log`: 2 failed, 99 passed for faithful full arrays containing an empty object and faithful empty siblings alongside meaningful content. `empty-object-green.log`: 101 passed after the comparator accepts only originally empty objects.
- `unit-final.log`: 165 scoped tests passed, comprising 112 native executor and 53 task-catalog cases. These include the saved synth-18 output, plain text quotes and all existing pending cases. Six new positive controls cover repeated names in different objects, escaped key spelling, quotes/backslashes in names, literal backslash-u versus Unicode names, JSON-looking string values and harmless prototype-related prefixes/ordinary own properties. Five new negative controls reject removing/reordering/inserting/changing an empty array member and emptying a nonempty sibling despite real content elsewhere. Existing fabricated path/value/type/array and numeric precision controls remain passing.
- `typecheck.log`, `lint.log`, `build.log`: `pnpm typecheck`, `CODEX_FULL_GATE=1 pnpm lint` and `CODEX_FULL_GATE=1 pnpm build` passed. Lint reports zero errors and the unchanged 297 warnings; build covers web, server, worker and migrate. `git diff --check` passed. No DB tests, provider calls, dependency changes, new review round or push.

Production source was unchanged through duplicate RED. Its first edit occurred during `2026-10-06 12:49:26–12:49:31 UTC`; final semantic edit was at `12:55:02 UTC`. Final `evidence-quote.ts` SHA-256 is `38f6d3bac97a1d3d451348beaf295fedf8c6698549196de19c4b999f29cb80f3`. Parent's two real MiMo calls started on the earlier head; their evidence cannot be attributed to this repair without checking the source loaded by those calls. This lane did not modify the temporary diagnostic, its database or evidence, dependency manifests, lockfile, or installed packages. Parent owns the sole verification review, fresh runtime acceptance if needed, Linear capture and PR delivery.
