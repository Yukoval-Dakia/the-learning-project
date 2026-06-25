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

use napi::bindgen_prelude::*;
use napi_derive::napi;

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
