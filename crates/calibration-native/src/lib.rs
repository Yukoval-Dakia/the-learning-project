//! YUK-493 Phase -1 — napi port of the offline calibration core.
//!
//! Bit-exact-parity port of:
//!   - src/server/calibration/rng.ts       (mulberry32)
//!   - src/server/calibration/auc.ts       (forwardAuc — Mann–Whitney U)
//!   - src/server/calibration/bootstrap.ts (resolveBootstrapB, percentile, deltaAucClusterBootstrap)
//!
//! The TS implementations stay the always-on ORACLE + runtime fallback. This crate
//! is verified bit-for-bit against them by src/server/calibration/native-parity.unit.test.ts.
//!
//! Determinism invariants (must hold for the parity test to pass):
//!   - mulberry32 is pure-integer (u32 wrapping) → bit-identical to JS (Math.imul == i32 wrapping_mul).
//!   - FFI passes the SEED (u32), never an rng closure → the whole PRNG stream runs in Rust.
//!   - forwardAuc accumulates +1.0 / +0.5 in pos-major,neg-minor order (integer-exact).
//!   - percentile uses two multiplies + one add, NO fused-multiply-add (f64::mul_add banned).
//!   - labels marshalled as Vec<f64> (a plain JS number[]) — NOT Vec<u32>: N-API ToUint32 would
//!     coerce a fractional/negative non-binary label (1.5 -> 1, -1 -> 4294967295) and silently
//!     diverge from the JS oracle's `!== 0 && !== 1` throw. f64 keeps the reject-non-binary error
//!     path byte-identical to auc.ts. (Vec<u8> would expect a Buffer.)

// ADR-0046 §6 prod-safety contract: no hand-written unsafe in the numerical core.
// `deny`, not `forbid`: napi-derive's `#[napi]` macro emits an `#[allow(unsafe_code)]` on its
// generated FFI registration glue, and `forbid` is the one lint level a local `allow` cannot
// override (E0453). `deny` errors on any hand-written `unsafe` block that does NOT carry its own
// local `#[allow]` — i.e. the no-accidental-unsafe intent of ADR §6. A deliberate
// `#[allow(unsafe_code)] unsafe { … }` can still bypass `deny` (forbid would catch even that, but
// is incompatible with napi); such a bypass is a visible review red flag. See ADR-0046 §6.
#![deny(unsafe_code)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::OnceLock;

// ─────────────────────────────────────────────────────────────────────────────
// mulberry32 — bit-identical port of rng.ts:14-23.
// ─────────────────────────────────────────────────────────────────────────────
struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    #[inline]
    fn new(seed: u32) -> Self {
        Mulberry32 { a: seed }
    }

    #[inline]
    fn next_f64(&mut self) -> f64 {
        // JS `a |= 0` is a no-op on the u32 bit pattern.
        // JS `a = (a + 0x6d2b79f5) | 0` -> low-32-bit wrapping add.
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let a = self.a;
        // JS `Math.imul(x, y)` == signed-i32 wrapping multiply, low 32 bits.
        let mut t: u32 = ((a ^ (a >> 15)) as i32).wrapping_mul((1u32 | a) as i32) as u32;
        let m: u32 = ((t ^ (t >> 7)) as i32).wrapping_mul((61u32 | t) as i32) as u32;
        // JS `(t + Math.imul(...)) ^ t` -> ToInt32(t+m) ^ t == wrapping_add then xor.
        t = t.wrapping_add(m) ^ t;
        // JS `((t ^ (t >>> 14)) >>> 0) / 4294967296` -> u32 -> f64 / 2^32.
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

/// First `n` mulberry32 draws for `seed` (each in [0, 1)). Mirrors rng.ts.
/// dev/CI-only differential-test binding; guards an absurd `n` so a stray caller can't
/// trigger an unbounded allocation that would crash the host Node process.
#[napi]
pub fn mulberry32_draws(seed: u32, n: u32) -> Result<Vec<f64>> {
    const MAX_DRAWS: u32 = 10_000_000; // far above any parity-test need (<= 1000)
    if n > MAX_DRAWS {
        return Err(Error::from_reason(format!(
            "mulberry32Draws: n ({n}) exceeds the {MAX_DRAWS} guard"
        )));
    }
    let mut rng = Mulberry32::new(seed);
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        out.push(rng.next_f64());
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// forwardAuc — port of auc.ts:40-76.
// ─────────────────────────────────────────────────────────────────────────────
struct AucInner {
    auc: Option<f64>,
    n: u32,
    n1: u32,
    n0: u32,
    reason: Option<&'static str>,
}

fn forward_auc_inner(scores: &[f64], labels: &[f64]) -> std::result::Result<AucInner, String> {
    if scores.len() != labels.len() {
        return Err("forwardAuc: scores and labels must have equal length".to_string());
    }
    let n = scores.len();
    let mut pos: Vec<f64> = Vec::new();
    let mut neg: Vec<f64> = Vec::new();
    for i in 0..n {
        let y = labels[i];
        // Mirror auc.ts:52 `y !== 0 && y !== 1` on the raw f64 (no ToUint32 coercion), so a
        // fractional/negative non-binary label throws byte-identically to the JS oracle.
        if y != 0.0 && y != 1.0 {
            return Err(format!(
                "forwardAuc: label at index {i} must be 0 or 1 (got {y})"
            ));
        }
        if y == 1.0 {
            pos.push(scores[i]);
        } else {
            neg.push(scores[i]);
        }
    }
    let n1 = pos.len();
    let n0 = neg.len();

    if n1 == 0 && n0 == 0 {
        return Ok(AucInner { auc: None, n: 0, n1: 0, n0: 0, reason: Some("empty") });
    }
    if n1 == 0 {
        return Ok(AucInner { auc: None, n: n as u32, n1: 0, n0: n0 as u32, reason: Some("no-positives") });
    }
    if n0 == 0 {
        return Ok(AucInner { auc: None, n: n as u32, n1: n1 as u32, n0: 0, reason: Some("no-negatives") });
    }

    // pos-major, neg-minor; +1.0 / +0.5 are integer-exact for u <= n1*n0.
    let mut u = 0.0_f64;
    for i in 0..n1 {
        let p = pos[i];
        for j in 0..n0 {
            let q = neg[j];
            if p > q {
                u += 1.0;
            } else if p == q {
                u += 0.5;
            }
            // p < q -> +0
        }
    }
    Ok(AucInner {
        auc: Some(u / ((n1 as f64) * (n0 as f64))),
        n: n as u32,
        n1: n1 as u32,
        n0: n0 as u32,
        reason: None,
    })
}

#[napi(object)]
pub struct AucResult {
    pub auc: Option<f64>,
    pub n: u32,
    pub n1: u32,
    pub n0: u32,
    pub reason: Option<String>,
}

#[napi]
pub fn forward_auc(scores: Vec<f64>, labels: Vec<f64>) -> Result<AucResult> {
    match forward_auc_inner(&scores, &labels) {
        Ok(r) => Ok(AucResult {
            auc: r.auc,
            n: r.n,
            n1: r.n1,
            n0: r.n0,
            reason: r.reason.map(str::to_string),
        }),
        Err(e) => Err(Error::from_reason(e)),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveBootstrapB — port of bootstrap.ts:49-76.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_POOLED_N_BEFORE_REDUCE: u32 = 5000;
const REDUCED_B: u32 = 500;
const HARD_POOLED_N_BEFORE_REDUCE: u32 = 20000;
const HARD_REDUCED_B: u32 = 200;

fn resolve_bootstrap_b_inner(pooled_n: u32, requested_b: u32) -> u32 {
    if pooled_n > HARD_POOLED_N_BEFORE_REDUCE && requested_b > HARD_REDUCED_B {
        return HARD_REDUCED_B;
    }
    if pooled_n > MAX_POOLED_N_BEFORE_REDUCE && requested_b > REDUCED_B {
        return REDUCED_B;
    }
    requested_b
}

#[napi]
pub fn resolve_bootstrap_b(pooled_n: u32, requested_b: u32) -> u32 {
    resolve_bootstrap_b_inner(pooled_n, requested_b)
}

// ─────────────────────────────────────────────────────────────────────────────
// percentile — port of bootstrap.ts:210-222. Linear interp on a pre-sorted asc array.
// ─────────────────────────────────────────────────────────────────────────────
fn percentile(sorted_asc: &[f64], p: f64) -> f64 {
    let n = sorted_asc.len();
    if n == 0 {
        return f64::NAN;
    }
    if n == 1 {
        return sorted_asc[0];
    }
    let rank = p * ((n - 1) as f64);
    let lo = rank.floor();
    let hi = rank.ceil();
    if lo == hi {
        return sorted_asc[lo as usize];
    }
    let frac = rank - lo;
    // Two multiplies + one add. NO mul_add (would diverge from V8 by an FMA rounding).
    sorted_asc[lo as usize] * (1.0 - frac) + sorted_asc[hi as usize] * frac
}

// ─────────────────────────────────────────────────────────────────────────────
// deltaAucClusterBootstrap — port of bootstrap.ts:116-208.
// ─────────────────────────────────────────────────────────────────────────────
#[napi(object)]
pub struct ClusterForwardPreds {
    pub scores_srt: Vec<f64>,
    pub scores_binary: Vec<f64>,
    pub labels: Vec<f64>,
}

#[napi(object)]
pub struct DeltaAucCi {
    pub point_delta: f64,
    pub auc_srt: Option<f64>,
    pub auc_binary: Option<f64>,
    pub ci_lo: f64,
    pub ci_hi: f64,
    pub b: u32,
    pub degenerate_replicates: u32,
    pub degenerate_fraction: f64,
    pub excludes_zero: bool,
}

fn pool_scores(clusters: &[ClusterForwardPreds], srt: bool) -> (Vec<f64>, Vec<f64>) {
    let mut scores: Vec<f64> = Vec::new();
    let mut labels: Vec<f64> = Vec::new();
    for c in clusters {
        let src = if srt { &c.scores_srt } else { &c.scores_binary };
        for i in 0..src.len() {
            scores.push(src[i]);
            labels.push(c.labels[i]);
        }
    }
    (scores, labels)
}

/// Paired whole-KC cluster bootstrap CI for ΔAUC. FFI passes `seed` (u32), NOT a
/// closure — the whole PRNG stream runs here, mirroring `mulberry32(seed)` JS-side.
#[napi]
pub fn delta_auc_cluster_bootstrap(
    clusters: Vec<ClusterForwardPreds>,
    b: u32,
    seed: u32,
) -> Result<DeltaAucCi> {
    // assertClusterAligned (bootstrap.ts:79-87)
    for (i, c) in clusters.iter().enumerate() {
        let n = c.labels.len();
        if c.scores_srt.len() != n || c.scores_binary.len() != n {
            return Err(Error::from_reason(format!(
                "cluster {i}: scoresSrt ({}), scoresBinary ({}), labels ({}) must be equal length",
                c.scores_srt.len(),
                c.scores_binary.len(),
                n
            )));
        }
    }

    let mut rng = Mulberry32::new(seed);
    let k = clusters.len();

    // Point estimate on the full pooled sample.
    let (pooled_srt_scores, pooled_srt_labels) = pool_scores(&clusters, true);
    let (pooled_bin_scores, pooled_bin_labels) = pool_scores(&clusters, false);
    let auc_srt = forward_auc_inner(&pooled_srt_scores, &pooled_srt_labels)
        .map_err(Error::from_reason)?
        .auc;
    let auc_binary = forward_auc_inner(&pooled_bin_scores, &pooled_bin_labels)
        .map_err(Error::from_reason)?
        .auc;
    let point_delta = match (auc_srt, auc_binary) {
        (Some(s), Some(bin)) => s - bin,
        _ => f64::NAN,
    };

    let pooled_n = pooled_srt_scores.len() as u32;
    let b_target = resolve_bootstrap_b_inner(pooled_n, b);

    let mut deltas: Vec<f64> = Vec::new();
    let mut degenerate: u32 = 0;
    let mut attempted: u32 = 0;

    if k > 0 {
        let k_f = k as f64;
        let k_minus_1 = (k - 1) as f64;
        for _rep in 0..b_target {
            attempted += 1;
            // Draw K cluster indices, ONE rng() per index, in i=0..k order (stream parity).
            let mut drawn: Vec<usize> = Vec::with_capacity(k);
            for _i in 0..k {
                let raw = (rng.next_f64() * k_f).floor();
                // clamp to [0, k-1] (defensive, matches JS Math.min/Math.max).
                let idx = if raw < 0.0 {
                    0usize
                } else if raw > k_minus_1 {
                    k - 1
                } else {
                    raw as usize
                };
                drawn.push(idx);
            }

            // Pool the resampled clusters — SAME draw for srt and binary (paired).
            let mut srt_scores: Vec<f64> = Vec::new();
            let mut bin_scores: Vec<f64> = Vec::new();
            let mut labels: Vec<f64> = Vec::new();
            for &ci in &drawn {
                let c = &clusters[ci];
                for i in 0..c.labels.len() {
                    srt_scores.push(c.scores_srt[i]);
                    bin_scores.push(c.scores_binary[i]);
                    labels.push(c.labels[i]);
                }
            }

            let a_srt = forward_auc_inner(&srt_scores, &labels).map_err(Error::from_reason)?.auc;
            let a_bin = forward_auc_inner(&bin_scores, &labels).map_err(Error::from_reason)?.auc;
            match (a_srt, a_bin) {
                (Some(s), Some(bin)) => deltas.push(s - bin),
                _ => {
                    // Degenerate replicate (single-class pool). COUNT, do NOT redraw.
                    degenerate += 1;
                }
            }
        }
    }

    let usable_b = deltas.len() as u32;
    let degenerate_fraction = if attempted > 0 {
        (degenerate as f64) / (attempted as f64)
    } else {
        0.0
    };

    let (ci_lo, ci_hi) = if usable_b > 0 {
        // deltas are finite by construction (degenerate replicates are skipped above).
        // total_cmp is a total order (NaN-safe, never panics) and is identical to partial_cmp
        // for finite values; deltas is not read after this, so sort in place (no clone). The JS
        // oracle's [...deltas].sort() clone is a JS necessity, not a parity constraint.
        deltas.sort_by(|x, y| x.total_cmp(y));
        (percentile(&deltas, 0.025), percentile(&deltas, 0.975))
    } else {
        (f64::NAN, f64::NAN)
    };

    let excludes_zero = ci_lo.is_finite() && ci_lo > 0.0;

    Ok(DeltaAucCi {
        point_delta,
        auc_srt,
        auc_binary,
        ci_lo,
        ci_hi,
        b: usable_b,
        degenerate_replicates: degenerate,
        degenerate_fraction,
        excludes_zero,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// YUK-495 Phase 0 (decision ②) — shared fixed-polynomial exp / σ.
// BIT-EXACT port of src/core/poly-exp.ts. Every constant, the Horner order, the
// floor-based range reduction, the Cody–Waite 2-part ln2, and the exponent-bit 2^k
// are copied verbatim from the TS oracle so polyExp/polySigmoid are Object.is-equal
// across V8 and this addon (verified by src/core/poly-exp-parity.unit.test.ts). NO mul_add:
// `p * r + c` must round twice exactly as V8 does — f64::mul_add would round once
// and break parity.
// ─────────────────────────────────────────────────────────────────────────────
// Built from exact IEEE-754 bit patterns — byte-identical to the TS `f64FromBits(...)`
// oracle, no decimal-parse ambiguity. LOG2E === Math.LOG2E === std LOG2_E.
const LOG2E: f64 = std::f64::consts::LOG2_E; // 0x3FF71547652B82FE
const LN2_HI: f64 = f64::from_bits(0x3FE6_2E42_FEE0_0000); // low mantissa zeroed → k·LN2_HI exact
const LN2_LO: f64 = f64::from_bits(0x3DEA_39EF_3579_3C76);

// Taylor 1/n! coefficients (exact rationals → identical to the TS literals).
const C2: f64 = 1.0 / 2.0;
const C3: f64 = 1.0 / 6.0;
const C4: f64 = 1.0 / 24.0;
const C5: f64 = 1.0 / 120.0;
const C6: f64 = 1.0 / 720.0;
const C7: f64 = 1.0 / 5040.0;
const C8: f64 = 1.0 / 40320.0;
const C9: f64 = 1.0 / 362880.0;
const C10: f64 = 1.0 / 3628800.0;
const C11: f64 = 1.0 / 39916800.0;
const C12: f64 = 1.0 / 479001600.0;
const C13: f64 = 1.0 / 6227020800.0;

/// 2^k via IEEE-754 exponent bits — exact, mirror of the TS `pow2i` typed-array
/// construction. k is an exact integer-valued f64 (output of floor); the cast is lossless
/// in the guarded range (|x| ≤ 708 → |k| ≤ ~1022, inside the normal-exponent window).
#[inline]
fn pow2i(k: f64) -> f64 {
    f64::from_bits((((1023.0 + k) as i64) as u64) << 52)
}

#[inline]
fn poly_exp_scalar(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    // Symmetric ±708 saturation. Lower guard MUST be -708 (not -745): pow2i builds only
    // NORMAL exponents (k >= -1022); for x <~ -709, k leaves that window and pow2i yields
    // sign-flipped garbage (cannot synthesise sub-normals). Mirror of poly-exp.ts.
    if x > 708.0 {
        return f64::INFINITY;
    }
    if x < -708.0 {
        return 0.0;
    }
    // k = round-half-up(x·log2e) via floor (identical to JS Math.floor; round() would
    // disagree at ties). k stays an f64 so `k * LN2_*` matches the TS float multiply.
    let k = (x * LOG2E + 0.5).floor();
    let r = x - k * LN2_HI - k * LN2_LO;

    // Horner, highest degree first, NO FMA.
    let mut p = C13;
    p = p * r + C12;
    p = p * r + C11;
    p = p * r + C10;
    p = p * r + C9;
    p = p * r + C8;
    p = p * r + C7;
    p = p * r + C6;
    p = p * r + C5;
    p = p * r + C4;
    p = p * r + C3;
    p = p * r + C2;
    p = p * r + 1.0; // r¹/1!
    p = p * r + 1.0; // r⁰/0!

    p * pow2i(k)
}

#[inline]
fn poly_sigmoid_scalar(x: f64) -> f64 {
    1.0 / (1.0 + poly_exp_scalar(-x))
}

/// Batch polyExp over `xs` — dev/CI-only differential-test binding for bit-parity
/// against src/core/poly-exp.ts `polyExp`.
#[napi]
pub fn poly_exp_batch(xs: Vec<f64>) -> Vec<f64> {
    xs.into_iter().map(poly_exp_scalar).collect()
}

/// Batch polySigmoid over `xs` — bit-parity target for src/core/poly-exp.ts `polySigmoid`
/// (the decision-② σ the live theta.ts/pfa.ts sigmoid will swap to in Phase 1).
#[napi]
pub fn poly_sigmoid_batch(xs: Vec<f64>) -> Vec<f64> {
    xs.into_iter().map(poly_sigmoid_scalar).collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// YUK-495 Phase 1 (#125 rider) — one-KC cold-start θ̂ grid solver.
// BIT-EXACT port of src/core/coldstart-solver.ts. Same GRID (-4 + i·step), the SHARED
// poly_sigmoid likelihood (NOT a libm exp), the same left-fold accumulation order, no FMA.
// One KC → no cross-KC coupling → sequential-Bayes grid fold (the determinism-clean core
// of #125; the coupled message-passing sweep layers on top in Phase 3).
// ─────────────────────────────────────────────────────────────────────────────
const GRID_MIN: f64 = -4.0;
const GRID_MAX: f64 = 4.0;
const GRID_POINTS: usize = 41;

#[napi(object)]
pub struct OneKcSolution {
    pub theta_hat: f64,
    pub se: f64,
    pub evidence: u32,
}

#[inline]
fn poly_binary_likelihood(offset: f64, b_prime: f64, outcome: f64) -> f64 {
    let p = poly_sigmoid_scalar(offset - b_prime);
    if outcome == 1.0 {
        p
    } else {
        1.0 - p
    }
}

/// Frozen GRID_THETA, built once (i·step is compile-time-constant-derived but float
/// arithmetic isn't const-evaluable in Rust). Same construction as theta-grid.ts and the
/// per-call form it replaces (-4 + i·((8)/(40))) → byte-identical values, no per-call alloc.
fn grid_theta() -> &'static [f64; GRID_POINTS] {
    static GRID: OnceLock<[f64; GRID_POINTS]> = OnceLock::new();
    GRID.get_or_init(|| {
        let grid_step = (GRID_MAX - GRID_MIN) / ((GRID_POINTS - 1) as f64);
        let mut g = [0.0_f64; GRID_POINTS];
        for (i, slot) in g.iter_mut().enumerate() {
            *slot = GRID_MIN + (i as f64) * grid_step;
        }
        g
    })
}

/// One-KC cold-start θ̂ from a locked difficulty anchor b' + binary answers, by
/// sequential-Bayes grid folding on the shared poly σ. Bit-parity target for
/// src/core/coldstart-solver.ts `solveThetaOneKc` (Object.is). `answers` are f64 (0.0/1.0),
/// mirroring forwardAuc's labels — avoids N-API ToUint32 coercion of non-binary inputs.
/// Returns Result and rejects any non-binary answer (matching forward_auc's label guard),
/// so a stray 0.5/2.0 from untyped JS throws loudly instead of silently corrupting θ̂.
#[napi]
pub fn solve_theta_one_kc(b_prime: f64, answers: Vec<f64>) -> Result<OneKcSolution> {
    // Reject non-binary up-front (the TS oracle is type-guarded by ReadonlyArray<0|1>; this
    // public napi fn is callable from untyped JS, so guard like forward_auc does for labels).
    for (i, &outcome) in answers.iter().enumerate() {
        if outcome != 0.0 && outcome != 1.0 {
            return Err(Error::from_reason(format!(
                "solveThetaOneKc: answer at index {i} must be 0 or 1 (got {outcome})"
            )));
        }
    }

    let grid_theta = grid_theta();

    let mass = 1.0 / (GRID_POINTS as f64);
    let mut probs: Vec<f64> = vec![mass; GRID_POINTS];

    for &outcome in &answers {
        let mut unnorm: Vec<f64> = vec![0.0; GRID_POINTS];
        let mut total = 0.0_f64;
        for i in 0..GRID_POINTS {
            let m = probs[i] * poly_binary_likelihood(grid_theta[i], b_prime, outcome);
            unnorm[i] = m;
            total = total + m; // left fold i=0..40, no reorder, no FMA
        }
        if !(total > 0.0) {
            // degenerate (underflow over the whole grid): keep prior shape, still count.
            continue;
        }
        for i in 0..GRID_POINTS {
            unnorm[i] = unnorm[i] / total;
        }
        probs = unnorm;
    }

    let mut mean = 0.0_f64;
    for i in 0..GRID_POINTS {
        mean = mean + probs[i] * grid_theta[i];
    }
    let mut var_acc = 0.0_f64;
    for i in 0..GRID_POINTS {
        let d = grid_theta[i] - mean;
        var_acc = var_acc + probs[i] * (d * d);
    }
    Ok(OneKcSolution {
        theta_hat: mean,
        se: var_acc.sqrt(),
        evidence: answers.len() as u32,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// YUK-513 Phase 2 (#123) — deterministic prereq prior-propagation (inc-E).
//
// NET-NEW, Rust-first (ADR-0046 §4 — no TS oracle; Rust-native KAT below). The crate's
// first GRAPH algorithm: a topological forward pass over the prereq DAG that gives every KC
// a day-one (n=0) mastery PRIOR before any answer is recorded.
//
// Research anchor = ALEKS / Knowledge Space Theory surmise relation
// (docs/design/2026-06-20-cold-start-day-one-design.md §1.3): "mastering B requires ALL of
// B's prerequisites". The continuous relaxation of that conjunction is a probabilistic-AND
// (∏), NOT a sum — KST's surmise is logical AND / set closure, never an additive gap.
//
// Math (STRENGTH and IDENTITY are orthogonal):
//   ① E_mastery(p) = Σ_j probs_p[j]·σ((θg_p + GRID_THETA[j]) − b_p)   ∈(0,1), COORDINATE-FREE
//   ② gap_B = 1 − ∏_{p∈prereqs(B)} E_mastery(p)   (probabilistic AND; ∈[0,1), scale-stable)
//      s_B   = gap_B · shrink_coeff                (shrink_coeff = owner-fixed const, NEVER fit)
//   ③ weight_i = σ(−s_B·GRID_THETA[i]);  post = renorm(weight)   (uniform prior factor cancels)
//   identity: weakest_prereq = argmin_p E_mastery(p)   (attribution; NOT folded into the scalar)
//
// Invariants:
//   - sits-lower (θ̂ < 0 when prereqs are weak) AND SE does NOT collapse (σ reweight spreads
//     mass across the negative half, it does not spike) → an honest, wide day-one band.
//   - NO-OP: a root / fully-mastered prereqs (gap→0 ⇒ s→0 ⇒ σ(0)=0.5 const ⇒ renorm = uniform)
//     ⇒ byte-identical to the cold-start uniform prior — the flag-OFF regression anchor PR-2 pins.
//   - cross-domain: E_mastery is a coordinate-free scalar evaluated in the prereq's OWN
//     (θg_p, b_p) frame, so prereq↔dep grids NEVER have to be aligned — this dissolves the
//     offset-grid risk (sketch §8 risk 3 / YUK-495 ⑦) instead of colliding with it.
//   - bit-exact: only poly_sigmoid_scalar + ×/−/Σ/÷; frozen GRID_THETA, left-fold sums, NO FMA.
//   - n=1-safe: reads b (locked anchor), shrink_coeff owner-const; no item-parameter fit, no
//     cohort dimension (DROP-7 red line holds).
//   - TOPO-ORDER-INVARIANT: each KC's value depends only on its prerequisites' FINAL values,
//     so any valid topological order yields the same f64 bits (true by construction; exercised
//     by the edge-input-order and diamond-DAG KATs below).
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct PrereqEdge {
    /// Index into `kc_ids` of the prerequisite KC.
    pub prereq_idx: u32,
    /// Index into `kc_ids` of the dependent KC.
    pub dep_idx: u32,
}

#[napi(object)]
pub struct GridPosterior {
    /// length-GRID_POINTS probability mass over the frozen GRID_THETA offset support (sums to 1).
    pub probs: Vec<f64>,
    /// number of real sequential-Bayes folds — always 0 here (day-one prior, no answers folded).
    pub evidence: u32,
    /// argmin attribution: id of this KC's weakest prerequisite (None for a root with no prereqs).
    pub weakest_prereq_id: Option<u32>,
    /// E_mastery of that weakest prerequisite, ∈(0,1) (None for a root).
    pub weakest_prereq_mastery: Option<f64>,
}

/// E[mastery] over a grid posterior, evaluated in the KC's OWN (θ_global, b) frame. A
/// coordinate-free scalar ∈(0,1): Σ left-fold i=0..40 over the shared poly σ, NO FMA. This is
/// the cross-domain-safe quantity that crosses a prereq edge (never a grid shape).
#[inline]
fn e_mastery_of(probs: &[f64], theta_global: f64, b: f64, grid: &[f64; GRID_POINTS]) -> f64 {
    debug_assert_eq!(
        probs.len(),
        GRID_POINTS,
        "e_mastery_of expects a GRID_POINTS-length posterior"
    );
    let mut acc = 0.0_f64;
    for i in 0..GRID_POINTS {
        acc = acc + probs[i] * poly_sigmoid_scalar(theta_global + grid[i] - b);
    }
    acc
}

struct PropagatedKc {
    probs: Vec<f64>,
    weakest_prereq_id: Option<u32>,
    weakest_prereq_mastery: Option<f64>,
}

fn propagate_priors_inner(
    kc_ids: &[u32],
    prereq_edges: &[(u32, u32)],
    b_per_kc: &[f64],
    domain_theta_global: &[f64],
    shrink_coeff: f64,
) -> std::result::Result<Vec<PropagatedKc>, String> {
    let n = kc_ids.len();
    if b_per_kc.len() != n || domain_theta_global.len() != n {
        return Err(format!(
            "propagatePriors: kc_ids ({}), bPerKc ({}), domainThetaGlobal ({}) must be equal length",
            n,
            b_per_kc.len(),
            domain_theta_global.len()
        ));
    }
    // shrink_coeff is an owner-fixed const, finite and ≥ 0. `!(finite && >= 0)` rejects NaN
    // (every NaN comparison is false), negatives, AND ±∞ — an infinite coeff would silently
    // degenerate every node to uniform via NaN weights instead of surfacing a config error.
    if !(shrink_coeff.is_finite() && shrink_coeff >= 0.0) {
        return Err(format!(
            "propagatePriors: shrinkCoeff must be finite and >= 0 (got {shrink_coeff})"
        ));
    }
    // b and θ_global are untyped-JS f64 inputs (DB-resident locked anchors). Guard finiteness
    // loudly — the crate idiom (forward_auc labels, solve_theta_one_kc answers) rejects bad f64
    // up front rather than letting a NaN anchor silently emit a phantom argmin attribution
    // (weakest_prereq_id=0, mastery=+∞ violating the documented ∈(0,1) contract).
    for i in 0..n {
        if !b_per_kc[i].is_finite() || !domain_theta_global[i].is_finite() {
            return Err(format!(
                "propagatePriors: bPerKc/domainThetaGlobal at index {i} must be finite (got b={}, θg={})",
                b_per_kc[i], domain_theta_global[i]
            ));
        }
    }

    // Adjacency. prereqs_of[d] kept ascending → frozen ∏ / argmin accumulation order.
    let mut prereqs_of: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut deps_of: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(p_u32, d_u32) in prereq_edges {
        let p = p_u32 as usize;
        let d = d_u32 as usize;
        if p >= n || d >= n {
            return Err(format!(
                "propagatePriors: edge ({p},{d}) out of range for {n} KCs"
            ));
        }
        if p == d {
            return Err(format!("propagatePriors: self-prerequisite at KC index {p}"));
        }
        prereqs_of[d].push(p);
        deps_of[p].push(d);
    }
    // Sort + DEDUP both adjacencies. A duplicate (prereq, dep) edge would otherwise double-count
    // in ∏ E_mastery (prod = m² not m) and silently over-shrink the posterior. indegree is then
    // built from the DEDUPED prereq counts so prereqs_of / deps_of / indegree stay mutually
    // consistent and the Kahn decrement reaches exactly zero.
    for v in prereqs_of.iter_mut() {
        v.sort_unstable();
        v.dedup();
    }
    for v in deps_of.iter_mut() {
        v.sort_unstable();
        v.dedup();
    }
    let indegree: Vec<usize> = prereqs_of.iter().map(|p| p.len()).collect();

    // Deterministic Kahn topological sort: seed with indegree-0 nodes in ascending index and
    // extend with newly-zeroed nodes in ascending index. (Any valid topo order yields the same
    // result — see the module note — but a fixed order keeps the pass reproducible.)
    let order = {
        let mut indeg = indegree.clone();
        let mut order: Vec<usize> = Vec::with_capacity(n);
        let mut queue: Vec<usize> = (0..n).filter(|&i| indeg[i] == 0).collect();
        let mut head = 0usize;
        while head < queue.len() {
            let u = queue[head];
            head += 1;
            order.push(u);
            let mut newly: Vec<usize> = Vec::new();
            for &d in &deps_of[u] {
                indeg[d] -= 1;
                if indeg[d] == 0 {
                    newly.push(d);
                }
            }
            newly.sort_unstable();
            queue.extend(newly);
        }
        if order.len() != n {
            return Err(
                "propagatePriors: prereq graph has a cycle (prerequisites must be a DAG)".to_string(),
            );
        }
        order
    };

    let grid = grid_theta();
    let uniform_mass = 1.0 / (GRID_POINTS as f64);

    let mut e_mastery: Vec<f64> = vec![0.0; n];
    let mut out_probs: Vec<Vec<f64>> = vec![Vec::new(); n];
    let mut out_weakest: Vec<Option<(u32, f64)>> = vec![None; n];

    for &kc in &order {
        let prereqs = &prereqs_of[kc];
        if prereqs.is_empty() {
            // Root → uniform prior (the cold-start mode; theta-grid.ts uniformPrior).
            out_probs[kc] = vec![uniform_mass; GRID_POINTS];
        } else {
            // ② strength = 1 − ∏ E_mastery (probabilistic AND), prereqs in ascending order.
            //    identity  = argmin E_mastery (strict < keeps the first / lowest-index on ties).
            let mut prod = 1.0_f64;
            let mut min_m = f64::INFINITY;
            let mut min_id: u32 = 0;
            for &p in prereqs {
                let m = e_mastery[p]; // topo guarantees prereq p already computed
                prod = prod * m;
                if m < min_m {
                    min_m = m;
                    min_id = kc_ids[p];
                }
            }
            let gap = 1.0 - prod;
            let s = gap * shrink_coeff;

            // ③ weight_i = σ(−s·θ_i); renorm (the uniform prior is a constant factor that cancels).
            let mut w: Vec<f64> = vec![0.0; GRID_POINTS];
            let mut total = 0.0_f64;
            for i in 0..GRID_POINTS {
                let wi = poly_sigmoid_scalar(-s * grid[i]);
                w[i] = wi;
                total = total + wi; // left fold i=0..40, no reorder, no FMA
            }
            if !(total > 0.0) {
                // σ>0 makes this unreachable for finite s; guard against NaN/overflow rather than
                // emit a non-distribution → fall back to the uniform prior.
                out_probs[kc] = vec![uniform_mass; GRID_POINTS];
            } else {
                for i in 0..GRID_POINTS {
                    w[i] = w[i] / total;
                }
                out_probs[kc] = w;
            }
            out_weakest[kc] = Some((min_id, min_m));
        }
        // E_mastery for THIS KC (used by its downstream deps) — computed AFTER its probs are set.
        e_mastery[kc] = e_mastery_of(&out_probs[kc], domain_theta_global[kc], b_per_kc[kc], grid);
    }

    let mut result: Vec<PropagatedKc> = Vec::with_capacity(n);
    for kc in 0..n {
        let (wid, wm) = match out_weakest[kc] {
            Some((id, m)) => (Some(id), Some(m)),
            None => (None, None),
        };
        result.push(PropagatedKc {
            probs: std::mem::take(&mut out_probs[kc]),
            weakest_prereq_id: wid,
            weakest_prereq_mastery: wm,
        });
    }
    Ok(result)
}

/// Deterministic prereq-DAG prior-propagation at n=0 (YUK-513 #123 / inc-E). PURE, no RNG.
/// `prereqEdges` are (prereqIdx, depIdx) index pairs into `kcIds`. Returns one GridPosterior per
/// KC in the SAME index order as `kcIds`: a day-one mastery prior shrunk toward lower ability by
/// the probabilistic-AND of its prerequisites' E_mastery, plus the weakest-prereq attribution.
/// `b` is READ-ONLY; `shrinkCoeff` is an owner-fixed const, never estimated.
#[napi]
pub fn propagate_priors(
    kc_ids: Vec<u32>,
    prereq_edges: Vec<PrereqEdge>,
    b_per_kc: Vec<f64>,
    domain_theta_global: Vec<f64>,
    shrink_coeff: f64,
) -> Result<Vec<GridPosterior>> {
    let edges: Vec<(u32, u32)> = prereq_edges
        .iter()
        .map(|e| (e.prereq_idx, e.dep_idx))
        .collect();
    let inner =
        propagate_priors_inner(&kc_ids, &edges, &b_per_kc, &domain_theta_global, shrink_coeff)
            .map_err(Error::from_reason)?;
    Ok(inner
        .into_iter()
        .map(|k| GridPosterior {
            probs: k.probs,
            evidence: 0,
            weakest_prereq_id: k.weakest_prereq_id,
            weakest_prereq_mastery: k.weakest_prereq_mastery,
        })
        .collect())
}

#[cfg(test)]
mod propagate_priors_tests {
    use super::*;

    fn mean(probs: &[f64]) -> f64 {
        let g = grid_theta();
        let mut m = 0.0_f64;
        for i in 0..GRID_POINTS {
            m += probs[i] * g[i];
        }
        m
    }
    fn se(probs: &[f64]) -> f64 {
        let g = grid_theta();
        let m = mean(probs);
        let mut v = 0.0_f64;
        for i in 0..GRID_POINTS {
            let d = g[i] - m;
            v += probs[i] * (d * d);
        }
        v.sqrt()
    }
    fn sum(probs: &[f64]) -> f64 {
        probs.iter().copied().sum()
    }

    #[test]
    fn root_is_uniform_no_op() {
        let r = propagate_priors_inner(&[10], &[], &[0.0], &[0.0], 0.5).unwrap();
        assert_eq!(r.len(), 1);
        let mass = 1.0_f64 / 41.0;
        for &p in &r[0].probs {
            assert_eq!(p.to_bits(), mass.to_bits()); // byte-identical to the uniform prior
        }
        assert!(r[0].weakest_prereq_id.is_none());
        assert!(r[0].weakest_prereq_mastery.is_none());
    }

    #[test]
    fn empty_graph_is_empty() {
        let r = propagate_priors_inner(&[], &[], &[], &[], 0.5).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn downstream_sits_lower_band_stays_wide() {
        // KC0 = root, KC1 depends on KC0. Root E_mastery ≈ 0.5 → gap ≈ 0.5 → s = 0.5.
        let r = propagate_priors_inner(&[0, 1], &[(0, 1)], &[0.0, 0.0], &[0.0, 0.0], 1.0).unwrap();
        // root stays neutral
        assert!(mean(&r[0].probs).abs() < 1e-9);
        // dependent sits lower (θ̂ < 0)
        assert!(
            mean(&r[1].probs) < -0.1,
            "dependent θ̂ should be negative, got {}",
            mean(&r[1].probs)
        );
        // but the band does NOT collapse (a uniform band has SE ≈ 2.37; a collapse would be < 0.5)
        assert!(
            se(&r[1].probs) > 1.5,
            "dependent SE should stay wide, got {}",
            se(&r[1].probs)
        );
        assert!((sum(&r[1].probs) - 1.0).abs() < 1e-12);
        assert_eq!(r[1].weakest_prereq_id, Some(0));
    }

    #[test]
    fn stronger_shrink_pushes_lower() {
        let weak =
            propagate_priors_inner(&[0, 1], &[(0, 1)], &[0.0, 0.0], &[0.0, 0.0], 0.3).unwrap();
        let strong =
            propagate_priors_inner(&[0, 1], &[(0, 1)], &[0.0, 0.0], &[0.0, 0.0], 1.5).unwrap();
        assert!(mean(&strong[1].probs) < mean(&weak[1].probs));
    }

    #[test]
    fn conjunction_two_weak_worse_than_one() {
        // Probabilistic AND: two weak prereqs accumulate (∏) → larger gap than one alone.
        // b = 2 makes a prereq "weak" (σ(grid − 2) is small over the grid → low E_mastery).
        let one =
            propagate_priors_inner(&[0, 9], &[(0, 1)], &[2.0, 0.0], &[0.0, 0.0], 1.0).unwrap();
        let two = propagate_priors_inner(
            &[0, 1, 9],
            &[(0, 2), (1, 2)],
            &[2.0, 2.0, 0.0],
            &[0.0, 0.0, 0.0],
            1.0,
        )
        .unwrap();
        assert!(
            mean(&two[2].probs) < mean(&one[1].probs),
            "two weak prereqs (∏) should push lower than one: two={} one={}",
            mean(&two[2].probs),
            mean(&one[1].probs)
        );
    }

    #[test]
    fn argmin_picks_weakest_prereq() {
        // dep idx2 with prereq idx0 (strong, b=-5 → high E) and idx1 (weak, b=5 → low E).
        let r = propagate_priors_inner(
            &[100, 200, 300],
            &[(0, 2), (1, 2)],
            &[-5.0, 5.0, 0.0],
            &[0.0, 0.0, 0.0],
            1.0,
        )
        .unwrap();
        assert_eq!(r[2].weakest_prereq_id, Some(200)); // the weak one's id
        let wm = r[2].weakest_prereq_mastery.unwrap();
        assert!(wm < 0.2, "weakest mastery should be low, got {wm}");
    }

    #[test]
    fn edge_input_order_invariant_bit_for_bit() {
        // Same DAG, edges supplied in two different ORDERS → byte-identical posteriors. (The
        // internal topo order is canonical regardless of edge order; the diamond DAG test below
        // additionally exercises a structure with multiple valid topological orders.)
        let a = propagate_priors_inner(
            &[0, 1, 2],
            &[(0, 1), (1, 2)],
            &[0.0, 0.0, 0.0],
            &[0.0, 0.0, 0.0],
            0.7,
        )
        .unwrap();
        let b = propagate_priors_inner(
            &[0, 1, 2],
            &[(1, 2), (0, 1)],
            &[0.0, 0.0, 0.0],
            &[0.0, 0.0, 0.0],
            0.7,
        )
        .unwrap();
        for kc in 0..3 {
            for i in 0..GRID_POINTS {
                assert_eq!(a[kc].probs[i].to_bits(), b[kc].probs[i].to_bits());
            }
        }
    }

    #[test]
    fn deterministic_bit_for_bit() {
        let a = propagate_priors_inner(&[0, 1], &[(0, 1)], &[1.0, 2.0], &[0.5, -0.5], 0.8).unwrap();
        let b = propagate_priors_inner(&[0, 1], &[(0, 1)], &[1.0, 2.0], &[0.5, -0.5], 0.8).unwrap();
        for kc in 0..2 {
            for i in 0..GRID_POINTS {
                assert_eq!(a[kc].probs[i].to_bits(), b[kc].probs[i].to_bits());
            }
        }
    }

    #[test]
    fn cross_domain_coordinate_free() {
        // prereq in domain θg=2.0, dep in domain θg=-1.0 → different frames; must run + be sane.
        let r =
            propagate_priors_inner(&[0, 1], &[(0, 1)], &[0.0, 0.0], &[2.0, -1.0], 1.0).unwrap();
        assert!((sum(&r[1].probs) - 1.0).abs() < 1e-12);
        assert_eq!(r[1].weakest_prereq_id, Some(0));
    }

    #[test]
    fn all_mastered_is_near_uniform() {
        // prereq strong (b=-10 → E≈1) → gap≈0 → s≈0 → APPROXIMATELY uniform. (Approximate, not
        // byte-identical: a fully-mastered NON-root has gap that is tiny-but-nonzero for finite b,
        // so s≠0; exact byte-uniform happens only at a structural root or shrink=0 — see
        // root_is_uniform_no_op / shrink_zero_byte_uniform_on_nonroot.)
        let r =
            propagate_priors_inner(&[0, 1], &[(0, 1)], &[-10.0, 0.0], &[0.0, 0.0], 1.0).unwrap();
        assert!(
            mean(&r[1].probs).abs() < 0.1,
            "all-mastered prereq → near-uniform, got mean={}",
            mean(&r[1].probs)
        );
    }

    #[test]
    fn cycle_is_rejected() {
        let e = propagate_priors_inner(&[0, 1], &[(0, 1), (1, 0)], &[0.0, 0.0], &[0.0, 0.0], 0.5);
        assert!(e.is_err());
    }

    #[test]
    fn out_of_range_edge_rejected() {
        let e = propagate_priors_inner(&[0, 1], &[(0, 5)], &[0.0, 0.0], &[0.0, 0.0], 0.5);
        assert!(e.is_err());
    }

    #[test]
    fn self_prereq_rejected() {
        let e = propagate_priors_inner(&[0], &[(0, 0)], &[0.0], &[0.0], 0.5);
        assert!(e.is_err());
    }

    #[test]
    fn negative_or_nan_shrink_rejected() {
        assert!(propagate_priors_inner(&[0], &[], &[0.0], &[0.0], -1.0).is_err());
        assert!(propagate_priors_inner(&[0], &[], &[0.0], &[0.0], f64::NAN).is_err());
    }

    #[test]
    fn length_mismatch_rejected() {
        let e = propagate_priors_inner(&[0, 1], &[], &[0.0], &[0.0, 0.0], 0.5);
        assert!(e.is_err());
    }

    #[test]
    fn non_finite_anchor_rejected() {
        // b / θg are untyped-JS f64 inputs — a NaN/Inf anchor must throw loudly, not silently
        // emit a uniform distribution + phantom (id=0, mastery=+∞) attribution.
        assert!(propagate_priors_inner(&[0], &[], &[f64::NAN], &[0.0], 0.5).is_err());
        assert!(propagate_priors_inner(&[0], &[], &[0.0], &[f64::INFINITY], 0.5).is_err());
        assert!(propagate_priors_inner(&[0], &[], &[f64::NEG_INFINITY], &[0.0], 0.5).is_err());
    }

    #[test]
    fn infinite_shrink_rejected() {
        // +∞ passes a bare `>= 0` check but degenerates every node to uniform via NaN weights —
        // the finite-guard turns that into a loud config error.
        assert!(propagate_priors_inner(&[0], &[], &[0.0], &[0.0], f64::INFINITY).is_err());
    }

    #[test]
    fn duplicate_edge_deduped_no_double_count() {
        // A duplicate (0,1) edge must NOT double-count in ∏ (would give E² not E) → byte-identical
        // to the single-edge result.
        let once =
            propagate_priors_inner(&[0, 1], &[(0, 1)], &[2.0, 0.0], &[0.0, 0.0], 1.0).unwrap();
        let twice =
            propagate_priors_inner(&[0, 1], &[(0, 1), (0, 1)], &[2.0, 0.0], &[0.0, 0.0], 1.0)
                .unwrap();
        for i in 0..GRID_POINTS {
            assert_eq!(once[1].probs[i].to_bits(), twice[1].probs[i].to_bits());
        }
    }

    #[test]
    fn product_conjunction_exact_two_roots() {
        // The centerpiece invariant: gap = 1 − ∏ E_mastery (probabilistic AND), NOT 1 − Σ(1−E)
        // nor an average. D depends on two ROOTS A0, A1 (uniform → E_mastery is computable from
        // e_mastery_of), so we can pin D's posterior BIT-FOR-BIT against the ∏ reference. A Σ or
        // average implementation produces different gap → different bits → this test fails.
        let coeff = 1.3_f64;
        let r = propagate_priors_inner(
            &[0, 1, 2],
            &[(0, 2), (1, 2)],
            &[0.5, 1.0, 0.0],
            &[0.0, -0.3, 0.0],
            coeff,
        )
        .unwrap();
        let grid = grid_theta();
        let uniform: Vec<f64> = vec![1.0_f64 / (GRID_POINTS as f64); GRID_POINTS];
        // E_mastery of each root, each in its OWN (θg, b) frame — same as the implementation.
        let e0 = e_mastery_of(&uniform, 0.0, 0.5, grid);
        let e1 = e_mastery_of(&uniform, -0.3, 1.0, grid);
        // gap = 1 − ∏E, mirroring the impl's `prod = 1.0; prod *= e0; prod *= e1` ascending fold.
        let mut prod = 1.0_f64;
        prod *= e0;
        prod *= e1;
        let s = (1.0 - prod) * coeff;
        let mut w: Vec<f64> = vec![0.0; GRID_POINTS];
        let mut total = 0.0_f64;
        for i in 0..GRID_POINTS {
            w[i] = poly_sigmoid_scalar(-s * grid[i]);
            total = total + w[i];
        }
        for i in 0..GRID_POINTS {
            let expected = w[i] / total;
            assert_eq!(
                r[2].probs[i].to_bits(),
                expected.to_bits(),
                "∏-conjunction mismatch at grid {i}"
            );
        }
        // Sanity: with two roots E0,E1 < 1, the ∏ gap (1−E0·E1) strictly exceeds either single-edge
        // gap (1−E0 or 1−E1) — i.e. two prereqs push lower than one, as a product should.
        assert_eq!(r[2].weakest_prereq_id, Some(1)); // A1 (higher b=1.0) is the weaker root
    }

    #[test]
    fn chain_deepens_monotonically() {
        // A → B → C: depth compounds. B reads A's E_mastery, C reads B's (already-shrunk → lower
        // E_mastery) → strictly C sits lower than B sits lower than the neutral root A.
        let r = propagate_priors_inner(
            &[0, 1, 2],
            &[(0, 1), (1, 2)],
            &[0.0, 0.0, 0.0],
            &[0.0, 0.0, 0.0],
            1.0,
        )
        .unwrap();
        let (ma, mb, mc) = (mean(&r[0].probs), mean(&r[1].probs), mean(&r[2].probs));
        assert!(ma.abs() < 1e-9, "root neutral, got {ma}");
        assert!(mb < ma, "B below A: B={mb} A={ma}");
        assert!(mc < mb, "C below B (depth compounds): C={mc} B={mb}");
        assert_eq!(r[2].weakest_prereq_id, Some(1)); // C's only prereq is B
    }

    #[test]
    fn diamond_dag_multiple_valid_orders() {
        // A→B, A→C, B→D, C→D. B and C both depend on A and are independent of each other, so more
        // than one valid topological order exists. Result must be edge-order-invariant, and D's
        // argmin must be the weaker of B/C. (B has higher b → weaker.)
        let edges_1 = [(0, 1), (0, 2), (1, 3), (2, 3)];
        let edges_2 = [(2, 3), (1, 3), (0, 2), (0, 1)];
        let b = [0.0, 5.0, 0.0, 0.0]; // B (idx1) weakest via high difficulty
        let tg = [0.0, 0.0, 0.0, 0.0];
        let a = propagate_priors_inner(&[0, 1, 2, 3], &edges_1, &b, &tg, 1.0).unwrap();
        let c = propagate_priors_inner(&[0, 1, 2, 3], &edges_2, &b, &tg, 1.0).unwrap();
        for kc in 0..4 {
            for i in 0..GRID_POINTS {
                assert_eq!(a[kc].probs[i].to_bits(), c[kc].probs[i].to_bits());
            }
        }
        assert!((sum(&a[3].probs) - 1.0).abs() < 1e-12);
        assert_eq!(a[3].weakest_prereq_id, Some(1)); // B is the weaker of D's two prereqs
    }

    #[test]
    fn shrink_zero_byte_uniform_on_nonroot() {
        // shrink=0 is the exact NO-OP boundary: on a NON-root node, s=0 → every weight σ(0)=0.5 →
        // renorm 0.5/20.5 which is byte-identical to the uniform 1/41 prior (the flag-OFF anchor).
        let r = propagate_priors_inner(&[0, 1], &[(0, 1)], &[0.0, 0.0], &[0.0, 0.0], 0.0).unwrap();
        let mass = 1.0_f64 / 41.0;
        for &p in &r[1].probs {
            assert_eq!(p.to_bits(), mass.to_bits());
        }
    }

    #[test]
    fn argmin_tie_breaks_to_lowest_index() {
        // Two prereqs with identical E_mastery (same b, same θg) → strict `<` keeps the FIRST
        // (lowest-index, ascending-sorted) prereq as the weakest.
        let r = propagate_priors_inner(
            &[100, 200, 300],
            &[(0, 2), (1, 2)],
            &[3.0, 3.0, 0.0], // idx0 and idx1 identical → tie
            &[0.0, 0.0, 0.0],
            1.0,
        )
        .unwrap();
        assert_eq!(r[2].weakest_prereq_id, Some(100)); // lowest-index prereq id on tie
    }
}
