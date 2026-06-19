// B4 (YUK-386) — matcher selection flags (PURE; no IO, no wiring). Mirrors
// core/selection-signals.ts:EARLY_KLP_ENABLED / practice/selection-constants.ts —
// module-level consts, no config table, no env. The flag lives in its own module so the
// matcher reads it via an IMPORTED binding, which db tests can mock through a getter
// (mirror candidate-signals.db.test.ts's EARLY_KLP_ENABLED getter mock) — a same-module
// bare-identifier read cannot be getter-mocked.

/**
 * Master flag for the answer_class hard filter in the matcher's pool fetch. **Default false
 * (dark-ship).**
 *
 * false (default) → demand.answerClass is RECEIVED on the Demand but NOT pushed into the
 *   pool-fetch WHERE (the gated-YUK-395 「v1 收下不进 WHERE」 behaviour is unchanged). The pool
 *   query is BYTE-IDENTICAL to pre-B4 (the legacy kindsMatch shim in rankPool is untouched).
 * true → demand.answerClass (when present) is forwarded to poolFetch.answerClass, adding the
 *   NULL-lenient hard filter `(answer_class = $X OR answer_class IS NULL)` to the WHERE so a
 *   candidate is eligible only if its answer_class matches the demand — a `steps` demand can
 *   NOT be filled by an `exact` candidate. NULL answer_class (un-backfilled legacy rows; A3
 *   fills NEW writes + the backfill job only) is NOT hard-excluded — it stays eligible via the
 *   lenient OR and is corrected over time as backfill/on-write coverage approaches 100%.
 *
 * STAYS FALSE in this PR (dark-ship): steps-vs-exact selection CORRECTNESS needs validation on
 * seeded data before any default-on flip — NOT this increment. The matcher has no live
 * production caller yet (only sourcing-sequence.ts calls poolFetch; matcher() is uncalled
 * outside its own tests), so this hardens the filter PRE-live-caller; the off-by-default flag
 * is the doubly-safe second layer. Flip to true only after seeded steps-vs-exact validation.
 */
export const MATCHER_ANSWER_CLASS_FILTER = false;
