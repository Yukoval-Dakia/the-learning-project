# Rust napi-rs Beachhead — Offline Calibration AUC + Cluster Bootstrap

- **Status**: Draft for owner review (→ implementation plan after approval)
- **Date**: 2026-06-24
- **Author**: design lead (synthesised from 3 lens findings: repo-integration, build/distribution, numeric-fidelity)
- **Scope tag (area)**: calibration / tooling
- **Motivation**: introduce a **Rust capability** into the codebase on the lowest-risk, most self-contained beachhead. **This is a capability beachhead, NOT a performance play.** The JS implementation stays as oracle + runtime fallback; the addon runs on an offline, report-only path with zero live blast radius.

> **How to read the confidence markers.** Claims grounded in `file:line` reads are marked ✅. External (napi.rs / IEEE-754) claims carry their source. Places a lens was uncertain are called out inline as ⚠️ **UNCERTAIN** so the owner can decide before this becomes a plan.

---

## 0. SPIKE VALIDATION — PASSED (2026-06-25)

A two-layer throwaway spike (in scratchpad `rust-spike/`, not committed) validated the toolchain + the bit-exact fidelity claim BEFORE full implementation. **All layers bit-exact.**

**Environment (verified this session):** Rust 1.94.1 + cargo + rustup; `@napi-rs/cli` → **napi 3.9.4 / napi-derive 3.5.7** (newer than §3.1's 3.8.4 — fine); Node v26.3.0; darwin-arm64; clang linker present. `napi build --release` produced `calibration-native.node` (397 KB) in ~12 s cold / ~4.5 s incremental, loadable via `require()` under Node.

- **Layer 0 — mulberry32:** 8 seeds × 1000 draws (incl. adversarial 0 / 0xffffffff / 0x80000000 and live seed 0x5eeda1c0) all `Object.is`-equal to the JS oracle; 0 range violations; the §4.1 reference vectors matched.
- **Layer 1 — forwardAuc:** 11 KAT/edge cases (perfect / inverted / ties / all-equal / single-class nulls / empty / extreme 1e308·denormal·−0) + 1000 randomized corpora (incl. tie-heavy) all `Object.is`-equal (auc + n/n1/n0/reason). Error paths throw **byte-identical** messages across FFI (incl. the interpolated `label at index 1 must be 0 or 1 (got 2)`).

**R1 (f64 cross-language bit-drift) is disproven at the PRNG + AUC-kernel + error-path layers.** The ONLY remaining unproven fidelity point is the percentile linear interpolation (I8, §4.3) — a single isolated function, deferred to full implementation.

**Three integration findings (already folded into the sections below):**
1. **labels marshalling (§3.2):** use `Vec<u32>` (maps cleanly from a JS `number[]` → generated TS `Array<number>`), NOT `Vec<u32>` (napi-rs treats `Vec<u32>` as a Buffer). The 0|1 guard stays. *(§3.2 updated accordingly.)*
2. **`Option<f64>` → JS `undefined`** (not `null`). The `bootstrap-native.ts` dispatcher (§2.2) must normalize `?? null` so addon output matches the JS oracle's `null` (`aucSrt`/`aucBinary`/`auc`).
3. **`Error::from_reason` crosses byte-identical** (incl. `format!`) — existing message-substring test asserts pass against the addon unchanged.

The validated `lib.rs` (bit-exact, reusable for `crates/calibration-native`) is in **Appendix B**.

---

## 1. OBJECTIVE & NON-GOALS

### 1.1 Objective

Stand up the project's **first first-party native (Rust) module** on a deliberately tiny, self-contained surface: the offline calibration bootstrap kernel. Success = a Rust `.node` addon that, given the same inputs and the same seed, produces **bit-identical** `DeltaAucCi` results to the existing JS, selected behind an opt-in flag, with JS as the always-available fallback. The point is to *prove out the Rust toolchain / FFI / build / test loop* in a context where being wrong cannot harm anything live.

### 1.2 What success looks like (acceptance criteria)

1. A Rust crate exposes `forward_auc` and `delta_auc_cluster_bootstrap` via napi-rs.
2. A differential unit test asserts **exact f64 equality** (`Object.is`, not `toBeCloseTo`) of every `DeltaAucCi` field across a seed × corpus matrix, JS vs Rust.
3. `pnpm audit:calibration` can run on the Rust path via an opt-in flag, and falls back to JS automatically when the `.node` is absent/disabled.
4. The Rust toolchain is **isolated to the builder/CI**; the prod runner image and a vanilla `pnpm test` on the dev Mac do **not** require a Rust install.
5. JS code paths (`auc.ts` / `bootstrap.ts` / `rng.ts`) are **untouched**; their existing unit tests stay green unchanged.

### 1.3 Non-goals (explicit)

- **NOT a perf optimisation.** Any speedup is incidental; we do not justify the work on throughput, and we do not benchmark-gate it. (The bootstrap is `O(n²)·2B` AUC calls — a real Rust speedup likely exists — but chasing it is out of scope; see §7 if the owner wants to fold a benchmark spike in.)
- **NOT a change to any live/nightly path.** The addon never enters `dist/server.cjs` / `dist/worker.cjs`, never enters `pnpm test`, never enters a cron/manifest job (verified §2).
- **NOT a distribution/cross-compile project.** Because the addon is offline-only, no prod-image overlay and no cross-compile matrix are *required* for the beachhead (§5). The Docker overlay pattern is documented as the *future* template only.
- **NOT a refactor of the JS kernels.** `auc.ts` / `bootstrap.ts` / `rng.ts` are the oracle; touching them would invalidate the parity proof.

---

## 2. SCOPE

### 2.1 Functions ported (exactly two kernels)

| JS function | File:line | Ported to Rust as | Why it's in scope |
|---|---|---|---|
| `forwardAuc(scores, labels)` | `src/server/calibration/auc.ts:40-76` ✅ | `forward_auc(scores: Vec<f64>, labels: Vec<u32>)` | The inner Mann-Whitney U kernel; called 2×B times per bootstrap run (`bootstrap.ts:173-174` ✅). |
| `deltaAucClusterBootstrap(clusters, opts)` | `src/server/calibration/bootstrap.ts:116-208` ✅ | `delta_auc_cluster_bootstrap(clusters, b, seed)` | The CPU-heavy outer resample loop; the headline kernel. |

`mulberry32` (`rng.ts:14-23` ✅) is ported **inside** the Rust crate as a private helper (not a separate exported binding) — it is consumed only by the bootstrap loop, and crossing the FFI line with a seed (not a closure) is the keystone decision (§3.4).

### 2.2 The swap seam (exact file:line)

The dispatch does **not** go inside `deltaAucClusterBootstrap` (that's the oracle — keep it pure). It goes **one level up**, at the single live call site:

- **Today**: `scripts/audit-calibration.ts:429` ✅ calls
  `evaluateVA1Forward(clusters, {}, mulberry32(BOOTSTRAP_SEED), {...})`
  where `BOOTSTRAP_SEED = 0x5eed_a1c0` (`audit-calibration.ts:28` ✅), building the rng **closure inline**.
- **Downstream**: `evaluateVA1Forward` calls `deltaAucClusterBootstrap(clusters, {b, rng})` at `v-a1-fwd.ts:296` and `v-a1-fwd.ts:311` ✅.

**The new seam** is a thin dispatcher in a **NEW file** `src/server/calibration/bootstrap-native.ts`:

```ts
// bootstrap-native.ts (NEW) — the ONLY swap site. Oracle files stay untouched.
export function deltaAucClusterBootstrapDispatch(
  clusters: ClusterForwardPreds[],
  opts: { b?: number; seed: number },   // <-- seed (u32), not an rng closure
): DeltaAucCi {
  if (useNative()) {                     // env flag + addon present (see §6)
    const addon = loadAddon();           // try/catch require; null on failure
    if (addon) return addon.deltaAucClusterBootstrap(clusters, opts.b ?? 2000, opts.seed >>> 0);
  }
  // Fallback = the untouched JS oracle, seeded identically:
  return deltaAucClusterBootstrap(clusters, { b: opts.b, rng: mulberry32(opts.seed) });
}
```

`v-a1-fwd.ts` (or `audit-calibration.ts`) is rewired to thread the **raw seed** to this dispatcher instead of constructing `mulberry32(seed)` itself.

> ⚠️ **UNCERTAIN (lens-flagged, decide in plan)** — *which* of the two call layers gets the seam:
> - **Option (i)** — change `evaluateVA1Forward` to accept `seed: number` and call the dispatcher at `v-a1-fwd.ts:296/311`. Cleaner (single internal choke point), but touches the keystone V-A1-fwd file and its signature.
> - **Option (ii)** — leave `v-a1-fwd.ts` alone; have `audit-calibration.ts:429` call a native-aware variant. Smaller diff to the keystone module, but the dispatch lives in the script.
>
> Recommendation: **(i)** — it makes the end-to-end parity test (§4, Layer 4) trivially exercise the *exact* path the live report uses, and `evaluateVA1Forward` already owns the bootstrap call. The signature change is internal (no live caller besides the audit script — verified §2.3).

### 2.3 What stays in JS (and why it's safe)

- **`auc.ts` / `bootstrap.ts` / `rng.ts`**: untouched, remain the oracle + runtime fallback.
- **All DB/assembly**: `loadAttempts` (`audit-calibration.ts:86` ✅, the only DB seam), `assembleForwardClustersDetailed` / `replayTheta` (`v-a1-fwd.ts:155-204` ✅) — pure JS, never crosses FFI. The Rust addon receives only the already-assembled `clusters` array.
- **Reporting**: `formatReport` / JSON output (`v-a1-fwd.ts:352`, `audit-calibration.ts:436-450` ✅) — JS.
- **Zero-blast-radius proof (verified, full transitive grep over `src/ scripts/ server/`)**:
  - `forwardAuc` is imported **only** by `bootstrap.ts:21` (+ barrel re-export `index.ts:10`) ✅ — no independent live/nightly caller.
  - `deltaAucClusterBootstrap` is imported **only** by `v-a1-fwd.ts:19` (+ `index.ts:32`) ✅. (The `./bootstrap` import in `mcp-bridge.ts:29` is a *different* `bootstrap.ts` — the copilot tool registrar — unrelated. ✅)
  - The only non-test caller of `evaluateVA1Forward` / `assembleForwardClusters*` is `audit-calibration.ts:423-429` ✅ — no manifest route, no pg-boss job.
  - `recalibration_nightly` cron (`practice manifest.ts:272`, `50 4 * * *`) is a **disjoint** path: it writes `item_calibration.b_calib` via BKT and does **not** import `auc`/`bootstrap`/`v-a1-fwd` ✅. ("calibration" name overlap only.)
  - **Conclusion**: the swap is automatically scoped to the offline report. Blast radius = the printed numbers of one hand-run audit.

---

## 3. CRATE & FFI DESIGN

### 3.1 Crate layout

```
crates/calibration-native/
  Cargo.toml          # crate-type = ["cdylib"]; deps: napi 3.8.x, napi-derive 3.8.x; build-dep: napi-build
  build.rs            # napi_build::setup()
  package.json        # name "calibration-native"; @napi-rs/cli 3.6.x devDep; "napi" config block (targets)
  src/
    lib.rs            # #[napi] bindings: forward_auc, delta_auc_cluster_bootstrap
    rng.rs            # mulberry32 (pure-integer port; §3.4)
    auc.rs            # forward_auc kernel (port of auc.ts; §4)
    bootstrap.rs      # resample loop + percentile (port of bootstrap.ts; §4)
  index.js            # GENERATED by napi (local-file-first loader)
  index.d.ts          # GENERATED
  calibration-native.<triple>.node   # built artifact (e.g. darwin-arm64 / linux-arm64-gnu)
```

Placement rationale (verified): scripts run under `tsx`, which resolves the `@/` alias from `tsconfig.json:17-18` (`"@/*": ["./src/*"]`) natively — no `tsconfig-paths` needed ✅. The addon is referenced as a node-resolvable package `calibration-native` (workspace pkg), loaded via `require`/dynamic import at runtime, exactly like `better-sqlite3`/`sharp` are loaded today ✅. (`@/` alias also works if we prefer `src/server/calibration/native/`; lens flagged a one-line smoke `import` should confirm the chosen resolution path before wiring — ⚠️ low-risk but verify.)

**Tooling versions (current as of 2026-06-24, source: napi.rs + npm, High reputation):**
- `@napi-rs/cli` **3.6.0** (npm, published 2026-06-24).
- `napi` / `napi-derive` core crate **3.8.x** (latest `napi-v3.8.4`, 2026-03-28, napi-rs GitHub releases).

### 3.2 napi-rs binding signatures

```rust
// src/lib.rs
use napi_derive::napi;
use napi::bindgen_prelude::*;

#[napi(object)]
pub struct ClusterForwardPreds {        // mirrors bootstrap.ts:24-28 ✅
  pub scores_srt: Vec<f64>,
  pub scores_binary: Vec<f64>,
  pub labels: Vec<u32>,                  // 0|1; non-binary -> thrown JS Error (auc.ts:51-54 ✅)
}

#[napi(object)]
pub struct AucResult {                  // mirrors forwardAuc return (auc.ts) ✅
  pub auc: Option<f64>,                 // null on single-class pool
  pub n: u32,
  pub n1: u32,
  pub n0: u32,
  pub reason: Option<String>,           // degenerate reason string, byte-identical to JS
}

#[napi(object)]
pub struct DeltaAucCi {                 // mirrors bootstrap.ts:30-47 ✅ (all 9 fields)
  pub point_delta: f64,                 // may be NaN (all-one-class pool) — see §4
  pub auc_srt: Option<f64>,
  pub auc_binary: Option<f64>,
  pub ci_lo: f64,
  pub ci_hi: f64,
  pub b: u32,                           // = deltas.length (non-degenerate replicate count)
  pub degenerate_replicates: u32,
  pub degenerate_fraction: f64,
  pub excludes_zero: bool,              // isFinite(ciLo) && ciLo > 0  (bootstrap.ts:206 ✅)
}

#[napi]
pub fn forward_auc(scores: Vec<f64>, labels: Vec<u32>) -> Result<AucResult> { /* §4 */ }

#[napi]
pub fn delta_auc_cluster_bootstrap(
  clusters: Vec<ClusterForwardPreds>,
  b: u32,        // opts.b; JS applies default 2000 before the call (DEFAULT_CONFIG.bootstrapB, v-a1-fwd.ts:41 ✅)
  seed: u32,     // <-- the seed, NOT an rng closure (§3.4)
) -> Result<DeltaAucCi> { /* §4 */ }
```

> napi-rs note (source: napi.rs concepts/object, High reputation): JS objects passed to/from Rust via `#[napi(object)]` are **cloned** across the boundary. Fine here — inputs are small and offline. `f64` round-trips as IEEE-754 double with **no precision loss** (JS `Number` ≡ Rust `f64`).

### 3.3 Input / output marshalling

- **In**: `clusters` arrive as `Vec<ClusterForwardPreds>` — three parallel `Vec<f64>`/`Vec<u32>` per cluster. `b: u32`, `seed: u32`. No JS function/closure crosses the boundary.
  - **`Vec<f64>` vs `Float64Array`**: for fidelity both are raw f64 (bit-exact). The existing `ClusterForwardPreds` shape is `number[]` (JS arrays), so `Vec<f64>` is the faithful match. Pick fidelity-of-signature over the zero-copy `TypedArray` micro-optimisation — **this is not the perf point** (§1.3).
- **Out**: the 9 scalar `DeltaAucCi` fields. `Option<f64>` → `null` for `auc_srt`/`auc_binary` single-class cases.
- **Errors**: `forward_auc` length-mismatch (`auc.ts:41`) and non-binary label (`auc.ts:52`), and `assertClusterAligned` (`bootstrap.ts:79-87`) map to thrown JS `Error`s. **The message substrings must match what the existing tests grep** (`/equal length/`, `/must be 0 or 1/`) so the suites pass against the addon unchanged ✅.

### 3.4 The SEED-not-closure decision (keystone)

The JS bootstrap consumes `rng()` at exactly one site: `Math.floor(rng() * k)` per cluster index (`bootstrap.ts:152-158` ✅). If we marshalled `rng()` calls across FFI we'd pay per-call boundary cost **and** introduce an order/fidelity hazard. Instead we pass the **raw `u32` seed** and re-create the entire PRNG stream in Rust. The whole resample→pool→AUC→delta→sort→percentile pipeline then runs in one language off one seed; the only cross-language contract is *"given seed `s` and corpus `C`, produce `DeltaAucCi`."* `0x5eeda1c0` = `1592550848`, a valid `u32` ✅.

**Bit-identical mulberry32 Rust port** (verified bit-for-bit against `rng.ts:14-23`):

```rust
// src/rng.rs — bit-identical port of src/server/calibration/rng.ts mulberry32.
pub struct Mulberry32 { a: u32 }

impl Mulberry32 {
    #[inline]
    pub fn new(seed: u32) -> Self { Mulberry32 { a: seed } } // JS: a = seed >>> 0 (already u32 at FFI)

    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        // JS L17 `a |= 0`  -> no-op on the u32 bit pattern.
        // JS L18 `a = (a + 0x6d2b79f5) | 0`
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let a = self.a;
        // JS L19 `let t = Math.imul(a ^ (a >>> 15), 1 | a);`
        //   Math.imul == (i32)·(i32) wrapping, low 32 bits.
        let mut t: u32 = ((a ^ (a >> 15)) as i32).wrapping_mul((1u32 | a) as i32) as u32;
        // JS L20 `t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;`
        let m: u32 = ((t ^ (t >> 7)) as i32).wrapping_mul((61u32 | t) as i32) as u32;
        t = t.wrapping_add(m) ^ t;
        // JS L21 `return ((t ^ (t >>> 14)) >>> 0) / 4294967296;`
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}
```

**Why each line is bit-identical** (the per-op argument, condensed):

| JS op | Rust equivalent | Bit-identity reason |
|---|---|---|
| `a \|= 0` | (none / comment) | reinterprets bits as i32 then back; no-op on a value already held as `u32`. |
| `(a + 0x6d2b79f5) \| 0` | `wrapping_add(0x6d2b79f5)` | operands < 2³² ⇒ f64 sum is exact (< 2⁵³), `\| 0` keeps low 32 bits ⇒ exactly wrapping add. |
| `Math.imul(x, y)` | `(x as i32).wrapping_mul(y as i32) as u32` | `Math.imul` is **signed-i32 wrapping multiply, low 32 bits**. *Empirically verified* on adversarial inputs (`0xffffffff`, `0x80000000`, large coprimes) — see §4.1. |
| `>>> n` | `u32 >> n` | unsigned/logical right shift on a u32 value. |
| `1 \| a`, `61 \| t` | `1u32 \| a`, `61u32 \| t` | bitwise-or; same result whether viewed as i32 or u32. |
| `(... >>> 0) / 4294967296` | `(u32 as f64) / 4294967296.0` | u32→f64 is exact (32-bit fits in 53-bit mantissa); divisor 2³² is exactly representable ⇒ one correctly-rounded IEEE-754 divide. |

**Conclusion: the PRNG is bit-identical with zero tolerance.** This is the foundation that makes the entire pipeline bit-exact.

---

## 4. NUMERIC FIDELITY

### 4.0 Verdict

**Bit-exact JS↔Rust parity is achievable — assert exact f64 equality (`Object.is`), NOT ULP tolerance.** Most of the arithmetic is integer-exact or exact-half-integer and is therefore *forced* to match; the only genuinely order-fragile / FMA-exposed line is the percentile interpolation, and default `rustc` already matches V8 there. If any differential test ever needs ULP slack, that is a **bug signal** (an order or FMA divergence) to fix, not a tolerance to accept.

### 4.1 Empirical grounding (run, not from memory)

`Math.imul` confirmed as signed-i32 wrapping multiply on adversarial inputs (Node v26.3.0): `imul(0xffffffff,0x7fffffff) = -2147483647`, `imul(0x80000000,2) = 0`, `imul(123456789,987654321) = -67153019`, `imul(0xdeadbeef,0xfeedface) = -1048049070` — all equal `(x as i32).wrapping_mul(y as i32)`.

**mulberry32 reference vectors (the parity anchor; first 6 draws, 17 sig digits):**

```
seed 12345      : [0.97972826776094735, 0.30675226449966431, 0.48420542152598500, 0.81793441250920296, ...]
seed 1          : [0.62707394058816135, 0.0027357211802154779, 0.52744703995995224, 0.98105096747167408, ...]
seed 2          : [0.73425094434060156, 0.32499843230471015, 0.28529605525545776, 0.53795515745878220, ...]
seed 99         : [0.26046581240370870, 0.80482276552356780, 0.54087153496220708, 0.69024342577904463, ...]
seed 0x5eeda1c0 : [0.64360520849004388, 0.22138935257680714, 0.88907548016868532, 0.26358552579768002, ...]
```

The Rust port must reproduce these byte-for-byte. (`1/2/99/12345` are the seeds `rng.unit.test.ts` already uses; `0x5eeda1c0` is the live report seed.) These vectors get committed as the Layer-0 fixture (§4.4).

### 4.2 The five bit-exact parity conditions (all satisfiable here)

1. **mulberry32 ports bit-identically** — proven §3.4 / §4.1 (pure integer + one exact divide).
2. **The FFI boundary passes the seed, not a closure** — §3.4; the whole stream lives in Rust.
3. **Operation order preserved verbatim** at every accumulation / iteration / sort site (§4.3).
4. **No FMA (fused multiply-add)** — the AUC kernel is pure `+=` so the pattern can't even arise; the one `a*b + c*d` site (percentile interp) must avoid `f64::mul_add`. Default `rustc` does **not** auto-contract `a*b+c` into FMA (Rust has no implicit fast-math) ⇒ plain code already matches V8.
5. **Round-to-nearest-ties-to-even + f64** — IEEE-754 default in both V8 and `rustc`; neither changes rounding mode.

### 4.3 The order / iteration invariants (each MUST be ported verbatim)

| # | Site | file:line ✅ | Invariant to preserve |
|---|---|---|---|
| I1 | AUC double-sum | `auc.ts:65-74` | `for i in 0..n1 { for j in 0..n0 { if p>q u+=1.0; else if p==q u+=0.5 } }` — **pos-major, neg-minor**; accumulator `u` is f64. (`+1`/`+0.5` are exact for `u ≤ n1·n0`, so the sum is exact regardless — but iterate in this order to guarantee it.) |
| I2 | pos/neg partition | `auc.ts:47-57` | partition by a single forward pass preserving **input index order** (fixes the I1 inner-loop order). |
| I3 | AUC final divide | `auc.ts:75` | `u / (n1*n0)` as **one** divide; compute `n1*n0` as an exact integer product cast to f64 (pin `(n1 as u64 * n0 as u64) as f64`, document it equals the JS `n1*n0` f64 product). |
| I4 | resample pool order | `bootstrap.ts:160-171` | for each drawn cluster (in **draw order**) push rows in **cluster-row order**, into srt/binary/labels in lockstep (**paired** — same draw feeds both). |
| I5 | index draw + clamp | `bootstrap.ts:152-158` | draw K indices in `i=0..k` order, **each consuming exactly one `next_f64()`**; `clamp(floor(rng()*k), 0, k-1)`. (Off-by-one in stream consumption desyncs everything.) |
| I6 | delta push order | `bootstrap.ts:181` | `deltas.push(aSrt.auc - aBin.auc)` in replicate order, **only for non-degenerate replicates** (`continue` at `:175-180` *before* push). |
| I7 | percentile sort | `bootstrap.ts:192` | `[...deltas].sort((a,b)=>a-b)` → Rust `sort_by(|a,b| a.partial_cmp(b).unwrap())` on **finite-only** f64. |
| I8 | percentile interp | `bootstrap.ts:210-222` | `rank=p*(n-1)`, `lo=floor`, `hi=ceil`; if `lo==hi` return `sorted[lo]`; else `frac=rank-lo`, `sorted[lo]*(1-frac)+sorted[hi]*frac` as **two multiplies + one add, NO `mul_add`**. |
| I9 | fraction/divides | `bootstrap.ts:186,206` | `degenerateFraction = (degenerate as f64)/(attempted as f64)`; `excludesZero = ciLo.is_finite() && ciLo > 0.0`. |

**The sharp edge (I7) — NaN ordering.** JS `sort((a,b)=>a-b)` and Rust `sort_by` differ on NaN. But `deltas` **cannot contain NaN by construction**: every degenerate/NaN replicate is `continue`d at `bootstrap.ts:175-180` *before* `deltas.push`, and `aSrt.auc - aBin.auc` of two finite AUCs in `[0,1]` is finite ✅. So `partial_cmp` is total, `.unwrap()` never panics, and the order matches JS. **Assert NaN-freedom of `deltas` explicitly in the harness** as a guard, even though it's structurally guaranteed. (Equal deltas → identical value, so JS sort stability vs Rust unstable sort is irrelevant to the percentile result.)

### 4.4 Differential-test matrix (seeds × corpora × every output field)

All tests are pure → `*.unit.test.ts` → no-DB fast partition (`vitest.shared.ts fastTestInclude`, `src/server/calibration/**/*.unit.test.ts` ✅), alongside the existing calibration tests. The addon load is `try/catch` so the suite runs JS-only when the `.node` is absent and runs the *differential* assertions only when present (skip-with-reason otherwise — keeps CI green without a built addon, proves parity when built).

**Assertion policy**: `Object.is(rust.field, js.field)` for every numeric field (distinguishes `-0`, `NaN`, `±Inf`), `===` for `b`/`excludesZero`. On failure, dump the bit patterns (`Buffer.from(Float64Array.of(x).buffer).toString('hex')`) for diagnosis.

- **Layer 0 — PRNG parity (foundation; must pass first).** Seeds `{1, 2, 99, 12345, 0x5eeda1c0, 0, 0xffffffff, 0x80000000}` → first 1000 `next_f64()` draws `Object.is`-equal to JS `mulberry32`, anchored against the §4.1 committed vectors. Assert every draw ∈ `[0,1)` (mirrors `rng.unit.test.ts:16-23`).
- **Layer 1 — `forward_auc` parity (inner kernel).** Re-run every existing KAT (`auc.unit.test.ts`) against Rust, exact-equal: `4/6`, ties `3.5/4` → `0.875`, perfect `1.0`, inverted `0.0`, the three null/reason single-class cases, empty, length-mismatch throw, non-binary-label throw. Plus seeded randomized corpora with **deliberate ties** (repeated scores), all-equal scores, and extreme values (`±1e308`, denormals); assert `auc` + `n/n1/n0/reason` equal.
- **Layer 2 — `resolveBootstrapB` parity.** `pooledN ∈ {1000, 5000, 5001, 20000, 20001, 1_000_000}` × `requestedB ∈ {2000, 500, 300, 200, 100}` exact-equal (mirrors `bootstrap.unit.test.ts:133-154`). (If `resolveBootstrapB` stays JS-side rather than re-ported, assert the reduced `b` echoed in the result still matches — see §3.2 note that JS applies the default.)
- **Layer 3 — `delta_auc_cluster_bootstrap` full parity (headline grid).** Seed sweep `{1, 7, 11, 42, 99, 0x5eeda1c0, 0, 0xffffffff}` × `b ∈ {100, 200, 300, 500, 2000}`, asserting the **entire** `DeltaAucCi` (`pointDelta, aucSrt, aucBinary, ciLo, ciHi, b, degenerateReplicates, degenerateFraction, excludesZero`) on these corpora (each seeded so JS and Rust get byte-identical inputs):
  1. **Strong-signal** (port `strongCluster`, `bootstrap.unit.test.ts:13-29`): K=20, n=8 → CI excludes 0.
  2. **Null-signal** (`scoresSrt === scoresBinary`): every Δ=0 → `ciLo≈ciHi≈0`, `excludesZero=false`.
  3. **Pairing check** (identical srt/binary, K=12, n=6): `ciLo,ciHi` exact 0.
  4. **Degenerate-heavy** (tiny single-row clusters): forces `degenerateReplicates>0` — asserts the `continue`-before-push (I6) NaN-freedom invariant.
  5. **All-one-class pool**: `pointDelta` is `NaN` on both → assert `Object.is(NaN, NaN)`.
  6. **`rng()===1.0` clamp** (`bootstrap.ts:98-110,157`): a top-of-range draw → assert clamp to `k-1` matches, finite result.
  7. **Varied K** `{1,2,3,5,15,20,50}` × **uniform and ragged cluster sizes** (exercises within-cluster row order, I4) × **class balance** `{50/50, 90/10, 10/90, single-row}`.
  8. **Tie-saturated corpora** (many equal scores → heavy `==` → +0.5 path, where any comparison-order bug surfaces).
  9. **Perf-cap tiers**: `pooledN` just over 5000 and just over 20000 → confirm reduced B applied identically *and* CI exact-equal. Run the largest tiers as a **single seed each** (O(N²)·B is expensive; the point is parity, not breadth); run small/medium exhaustively.
  10. **Misaligned cluster** (`bootstrap.ts:79-86`): assert both throw `/equal length/`.
  - **Property invariant** (cheap): for a random corpus+seed, `degenerateReplicates + b === attempted` on both sides.
- **Layer 4 — end-to-end through `v-a1-fwd`.** Feed a fixed synthetic cluster set through `evaluateVA1Forward(..., seed, ...)` with addon ON vs OFF and assert the whole verdict object (`aucSrt, aucBinary, ciLo, ciHi, verdict`, `v-a1-fwd.ts:299-334`) is `Object.is`-equal — guarantees the keystone gate can't move regardless of engine.

> ⚠️ **Belt-and-suspenders (lens-flagged)**: add a single Rust unit assertion that `a*b + c*d != f64::mul_add(a,b, c*d)` on a known-divergent input, to lock-in the no-FMA invariant (I8) against future codegen/feature drift.

---

## 5. BUILD / DISTRIBUTE / LOAD / TEST PIPELINE

### 5.0 The decisive scoping fact

**`audit:calibration` does NOT run in the prod image, in `pnpm test`, or in CI/cron** (all verified):
- `pnpm test` = `audit:profile && audit:draft-status && test:unit && test:db && test:migration` — **`audit:calibration` is absent** (`package.json:17` ✅).
- Not in any `.github/` workflow, manifest, or cron (zero hits beyond the script + its tests) ✅.
- The prod `runner` (`Dockerfile:59-88`, CMD `node dist/server.cjs`) and worker (`dist/worker.cjs`) neither bundle nor invoke `audit-calibration.ts` (it's `tsx`-only, not in any `esbuild --bundle` target: `build:server`/`build:worker`/`build:migrate`, `package.json:11,12,56` ✅).

**Therefore the addon only needs to be buildable on (a) the owner's dev machine (to run the audit) and (b) the CI runner that executes `test:unit` (to run the differential test).** No `rustdeps` Docker stage, no prod-image overlay, no cross-compile matrix is *required* for the beachhead. **Is the addon needed in prod? No.**

### 5.1 Recommended build approach (solo/NAS): toolchain isolated to builder/CI

Two surfaces actually need a `.node`:

1. **Dev machine (Mac, `darwin arm64`, Node v26.3.0 — verified ✅).** The owner runs `pnpm audit:calibration`. Build the host-arch `.node` once with `pnpm --filter calibration-native build` (`napi build --release --platform`). To avoid forcing a Rust install on every dev checkout, the addon stays **opt-in** (§6): without the `.node`, the audit silently uses JS. Optionally commit one `darwin-arm64` `.node` for zero-friction local opt-in (cost: one binary blob in git — acceptable for a single dev arch; document it).
2. **CI runner (for `test:unit`).** The differential test runs only when the addon is present; otherwise it skips-with-reason (so the gate is green even if CI has no Rust). To *actively* run parity in CI, add a `pretest`/CI step `napi build --release --platform` before `vitest`, then run the suite — the freshly built `.node` is co-located so the loader finds it. **Do NOT make a green `pnpm test` on the dev Mac require a Rust toolchain** — that would violate the "toolchain isolated to builder/CI" criterion.

The Rust toolchain (rustup + LLVM, ~1–1.5 GB) thus lives only in the builder/CI context and never in the slim runner.

### 5.2 Cross-compile / arch handling

- **Dev arch**: `darwin-arm64` — build natively, no cross-compile.
- **CI arch**: build natively for the CI runner's own arch (host-arch `napi build --platform`). No matrix needed for a report-only test.
- **Cross-compile is deferred, not required.** napi-rs v3 *does* support real cross-compilation (`--cross-compile`/`-x`, `--use-napi-cross`, `cargo-zigbuild`+`cargo-xwin`, targets x86_64/arm64/armv7/ppc64le/s390x at GLIBC 2.17 — source: napi.rs announce-v3 / cross-build, High reputation). It only enters scope **if/when the addon graduates onto the bundled live server/worker** (not in this beachhead).

### 5.3 Loading

- **Under `tsx` (dev / `audit:calibration`)** — the napi-generated `index.js` is **local-file-first**: it `existsSync`+`require`s the co-located `<name>.<triple>.node` before falling back to a per-platform npm sub-package (source: napi.rs cli/build, High reputation). `tsx` runs Node with esbuild transpile but does **not** intercept `.node` dlopen — Node's native `process.dlopen` handles it, same mechanism `better-sqlite3` uses at runtime ✅. **This is the primary load path.**
- **Under bundled prod (`.cjs`)** — *not needed for the beachhead* (§5.0). Documented for the future: esbuild **cannot bundle `.node`**, so a future live wire-in must add `--external:calibration-native` to `build:server` + `build:worker` (joining `--external:sharp --external:better-sqlite3`, `package.json:11,56` ✅), leaving `require('calibration-native')` a runtime resolve against `node_modules/`. **Cheap insurance**: add the `--external:` entry now so a future move doesn't break the bundle — but it's optional for the beachhead since nothing live imports the addon.

### 5.4 Vitest integration + build ordering

- vitest does **not** compile Rust → the `.node` must exist *before* `vitest run`. Either a `pretest` `napi build` step (CI) or a committed dev `.node`, with the parity test **guarded skip-if-absent** so a missing build degrades to "JS-only, addon test skipped" not a red bar.
- The parity test file `calibration-native.parity.unit.test.ts` drops under `src/server/calibration/` and is **auto-collected** by the existing glob — no config change ✅.
- vitest/esbuild transform TS but leave `require('....node')` alone (same externalization as prod), so the addon loads natively in the test process.

### 5.5 The Dockerfile 4th-stage pattern (FUTURE template — out of scope for beachhead)

Documented only as the template **if** the addon ever migrates onto the bundled live path. It mirrors the existing overlay (verified `Dockerfile:24-84` ✅): native deps are built in dedicated `node:24-bookworm-slim` stages (`sharpdeps`/`sdkdeps`/`sqlitedeps`) then `COPY --from` into the slim `runner` (`FROM node:24-slim`).

```dockerfile
# === FUTURE 4th stage (NOT in beachhead scope) ===
FROM node:24-bookworm-slim AS calibrationdeps
# install rustup + cargo (builder-only; discarded), then:
#   napi build --release --platform -o .   (host = build arch; run `docker build` ON the NAS arch)
# produces calibration-native.<nas-triple>-gnu.node + index.js + index.d.ts

# ...in FROM base AS runner:
# COPY --from=calibrationdeps /app/calibration-native.<triple>-gnu.node ./node_modules/calibration-native/
# COPY --from=calibrationdeps /app/index.js                            ./node_modules/calibration-native/
# COPY --from=calibrationdeps /app/index.d.ts                          ./node_modules/calibration-native/
```

> **The GLIBC trap (the #1 distribution risk if this stage is ever built).** The runner is `node:24-slim` = Debian = **glibc** (`Dockerfile:5,59` ✅). The builder stage **must** be glibc (`node:24-bookworm-slim`, matching the existing `*deps` stages) producing a `…-gnu.node`. **Never** an Alpine/musl builder — the loader would seek `…-gnu.node` at runtime and the musl artifact would be absent or `dlopen`-fail with a cryptic symbol error. **Builder libc must equal runner libc — full stop.** A CI assertion that the produced filename ends in `-gnu.node` is the cheap guard.

---

## 6. FALLBACK & ROLLOUT

### 6.1 Selection logic (opt-in + automatic fallback)

```ts
// in bootstrap-native.ts
function useNative(): boolean {
  return process.env.CALIBRATION_NATIVE === '1';   // default OFF (JS is the default everywhere)
}
let _addon: AddonModule | null | undefined;
function loadAddon(): AddonModule | null {
  if (_addon !== undefined) return _addon;          // memoize one resolution attempt
  try { _addon = require('calibration-native'); }    // or dynamic import under ESM
  catch { _addon = null; }                            // MODULE_NOT_FOUND / dlopen failure -> JS
  return _addon;
}
```

Two independent gates, both must pass to use Rust:
1. **Opt-in flag** `CALIBRATION_NATIVE=1` — even when the `.node` exists, the owner explicitly chooses native. Default OFF.
2. **Addon present + loadable** — `try/catch` `require`. A missing/incompatible (wrong-arch) `.node` silently degrades to JS — never a hard failure on a report-only path.

So the JS oracle is the default **everywhere the `.node` isn't built or the flag isn't set**, satisfying "JS stays as oracle AND runtime fallback, fully reversible, zero capability loss."

### 6.2 How to flip it on

```bash
pnpm --filter calibration-native build      # produce the host-arch .node (one-time per arch)
CALIBRATION_NATIVE=1 pnpm audit:calibration # run the report on the Rust path
```

Differential test asserts both paths agree before anyone trusts the native numbers.

### 6.3 Reversibility

- **Unset the flag** (or delete the `.node`) → instant revert to JS, no code change.
- **Oracle never touched** → JS path provably unchanged; its existing unit tests are the regression net.
- **No live consumer** → reverting cannot affect any route/job/cron (§2.3).
- The flag also enables a future "shadow mode" (run both, log mismatches) if the owner ever wants continuous parity monitoring — but that's out of scope here.

---

## 7. OPEN QUESTIONS / SPIKES

| # | Item | Status | Blocks what |
|---|---|---|---|
| Q1 | **NAS CPU arch (arm64 vs x86_64)** — `docker-compose.yml` has no `platform:` key; no committed first-party `.node` ✅ | ⚠️ **REQUIRED INPUT, but NOT blocking the beachhead** | Only the *future* Docker overlay (§5.5). The beachhead never ships to the NAS, so this is deferred. Resolve before any live-path migration with one command on the NAS: `docker info --format '{{.Architecture}}'` (or `uname -m`). |
| Q2 | Addon resolution path: workspace pkg `calibration-native` vs `@/server/calibration/native/` | ⚠️ low-risk, verify | A one-line smoke `import` under `tsx` before wiring the dispatcher confirms it (lens-flagged). |
| Q3 | Seam layer choice — `evaluateVA1Forward` signature change (Option i) vs script-level (Option ii) | Decide in plan | §2.2; recommend (i). |
| Q4 | Commit a `darwin-arm64` `.node` for zero-friction local opt-in, or require `napi build`? | Decide in plan | Dev ergonomics only; default = require build, addon opt-in. |
| Q5 | Should `resolveBootstrapB` be re-ported to Rust or stay JS-side (applied before the call)? | Decide in plan | Affects Layer-2 test shape (§4.4). Re-porting keeps the whole stream in one language (cleaner); JS-side keeps the Rust surface minimal. |
| Q6 | **(Optional) perf spike** — IF the owner wants to later justify perf, benchmark JS vs Rust at `b=2000`, large `pooledN`. | Out of scope unless requested | Not a beachhead gate (§1.3). |

**No benchmark/spike is required before committing to the beachhead.** Q1 is genuinely open but does not block (it gates only a future migration). Everything fidelity-related is exercisable locally on `darwin-arm64`.

---

## 8. EFFORT

Estimates for a solo polyglot maintainer, assuming Rust familiarity but **first napi-rs module in this repo**. Ranges reflect the napi-rs-first-time tax.

| Phase | Work | Estimate |
|---|---|---|
| **A. Toolchain setup** | rustup + `@napi-rs/cli` 3.6, `napi new` scaffold, `Cargo.toml`/`build.rs`/workspace pkg wiring, first `napi build` producing a `darwin-arm64` `.node`, one-line smoke `import` under `tsx` (Q2). | **0.5–1 day** |
| **B. The port** | `rng.rs` (mechanical, bit-identical — §3.4), `auc.rs` (verbatim double-sum, error messages), `bootstrap.rs` (resample loop, percentile, `resolveBootstrapB` if re-ported), `lib.rs` `#[napi]` bindings + `DeltaAucCi` marshalling, the `bootstrap-native.ts` dispatcher + seam rewire (§2.2). | **1.5–2.5 days** |
| **C. Differential tests** | Layer 0–4 matrix (§4.4): commit reference vectors, port `strongCluster`/seed fixtures, exact-equality harness with bit-pattern diff, skip-if-absent guard, no-FMA Rust assertion. The fidelity *proving* (chasing any divergence to its order/FMA root) is the variable cost. | **1–2 days** (could spike if a divergence appears) |
| **D. CI/Docker wiring** | `pretest` `napi build` step for CI parity run (or skip-guard only), `--external:` insurance entry, README/CLAUDE.md note. *(No prod Docker stage — out of scope, §5.0.)* | **0.5 day** |
| **Total** | | **~3.5–6 days** |

The widest variance is C (fidelity proving) — high confidence it's exact, but "prove every field bit-equal across the matrix" is where the time actually goes.

---

## 9. RISKS (ranked, for a solo polyglot maintainer)

| Rank | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R1** | **f64 cross-language bit-drift** (order or FMA divergence on some corpus) | Low | Medium (the whole parity claim) | Exact-equality matrix (§4.4) catches it *loudly*; port every order invariant verbatim (§4.3); no `mul_add` + the belt-and-suspenders FMA assertion (I8). The kernel is `+`/`*`/compare/sort/divide only — no transcendentals — so exact is realistic. **If a test ever needs ULP slack, treat as a bug, not a tolerance.** |
| **R2** | **Maintenance burden of a polyglot codebase** (the real cost of a capability beachhead) | Certain | Low–Medium (ongoing) | This is the *point* of choosing a tiny, offline, no-live-caller surface. The Rust footprint is ~3 small files; JS oracle is the always-on fallback so Rust rot can't break the report. Keep it opt-in until the owner is comfortable. |
| **R3** | **GLIBC/musl ABI mismatch** *if* a Docker stage is ever added | Low (out of scope now) | High (silent `dlopen` fail) | Builder base = runner base family (`node:24-bookworm-slim` glibc); `…-gnu` triple; CI filename assertion. Documented §5.5; not in beachhead scope. |
| **R4** | **napi-rs version/API churn** (v3 is current; `@napi-rs/cli` moves fast — published same-day) | Low | Low | Pin `@napi-rs/cli` and `napi`/`napi-derive` versions in `package.json`/`Cargo.toml`; the FFI surface used (struct args/returns, `Vec<f64>`/`u32`) is stable v3 API. Re-check napi.rs docs at impl time per the context7 rule. |
| **R5** | **Build-ordering / loader resolution surprise** (`.node` not found under `tsx`/vitest) | Low | Low | Local-file-first loader + Node `process.dlopen` is the same path `better-sqlite3` uses ✅; smoke `import` (Q2) before wiring; skip-if-absent guard means a miss degrades gracefully, never red. |
| **R6** | **Scope creep into perf / cross-compile / prod overlay** | Medium (temptation) | Medium (defeats "lowest-risk beachhead") | §1.3 non-goals + §5.0 scoping fact are the guardrails. Q1/Q6 explicitly deferred. |

---

## Appendix — evidence index (file:line, all ✅ verified)

- mulberry32: `src/server/calibration/rng.ts:14-23` (pure-integer + final `/4294967296`).
- AUC kernel: `auc.ts:40-76` (double-sum `:65-74`, partition `:47-57`, divide `:75`, errors `:41,51-54`, single-class null `:61-63`).
- Bootstrap: `bootstrap.ts:116-208` — `ClusterForwardPreds` `:24-28`, `DeltaAucCi` `:30-47`, `resolveBootstrapB` `:49-76`, `assertClusterAligned` `:79-87`, draw+clamp `:152-158`, pool order `:160-171`, `forwardAuc` calls `:130-131,173-174`, degenerate `continue` `:175-181`, sort `:192`, percentile `:210-222`, `excludesZero` `:206`.
- Call path: `audit-calibration.ts` (`BOOTSTRAP_SEED=0x5eed_a1c0` `:28`, seam call `:429`, DB seam `:86`, exit code `:464-466`); `v-a1-fwd.ts` (`DEFAULT_CONFIG.bootstrapB=2000` `:41`, bootstrap calls `:296,311`, verdict read `:299-334`, assembly `:155-204`).
- No-live-caller: `forwardAuc` only in `bootstrap.ts:21`+`index.ts:10`; `deltaAucClusterBootstrap` only in `v-a1-fwd.ts:19`+`index.ts:32`; `recalibration_nightly` disjoint (`practice manifest.ts:272`).
- Build/infra: `package.json` (`test` omits calibration `:17`, `audit:calibration` `:38` `tsx`, externals `:11,12,56`); `Dockerfile` (runner `node:24-slim` `:5,59`, native stages `:24,41,55`, `COPY --from` `:74-84`); `tsconfig.json:17-18` (`@/` alias).
- Environment (verified this session): dev = `darwin arm64`, Node `v26.3.0`.

**External sources (napi.rs official + npm, High reputation):** [napi build CLI](https://napi.rs/docs/cli/build), [cross-build](https://napi.rs/docs/cross-build.en), [v3 announce](https://napi.rs/blog/announce-v3), [object concepts](https://napi.rs/docs/concepts/object), [release native packages](https://napi.rs/docs/deep-dive/release); `@napi-rs/cli` 3.6.0 / `napi` 3.8.4 (npm + GitHub releases). IEEE-754 determinism: Wikipedia IEEE 754, WG21 P3375R3 (2025). `Math.imul` semantics + mulberry32 vectors: locally executed on Node v26.3.0.

---

## Appendix B — Spike-validated Rust (`lib.rs`), 2026-06-25

Bit-exact against the JS oracle (Layer 0 + Layer 1, see §0). Reusable as the seed for `crates/calibration-native/src/`. The bootstrap loop + percentile (I8) are NOT yet ported — that is the full-implementation work.

```rust
use napi::bindgen_prelude::*;
use napi_derive::napi;

// Layer-0: mulberry32 — bit-identical port of src/server/calibration/rng.ts.
struct Mulberry32 { a: u32 }
impl Mulberry32 {
    #[inline]
    fn new(seed: u32) -> Self { Mulberry32 { a: seed } }
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

#[napi]
pub fn mulberry32_draws(seed: u32, n: u32) -> Vec<f64> {
    let mut rng = Mulberry32::new(seed);
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n { out.push(rng.next_f64()); }
    out
}

// Layer-1: forwardAuc — port of src/server/calibration/auc.ts:40-76.
#[napi(object)]
pub struct AucResult {
    pub auc: Option<f64>,   // -> JS `undefined`; dispatcher must `?? null` to match JS oracle
    pub n: u32,
    pub n1: u32,
    pub n0: u32,
    pub reason: Option<String>,
}

#[napi]
pub fn forward_auc(scores: Vec<f64>, labels: Vec<u32>) -> Result<AucResult> {
    if scores.len() != labels.len() {
        return Err(Error::from_reason("forwardAuc: scores and labels must have equal length"));
    }
    let n = scores.len();
    let mut pos: Vec<f64> = Vec::new();
    let mut neg: Vec<f64> = Vec::new();
    for i in 0..n {
        let y = labels[i];
        if y != 0 && y != 1 {
            return Err(Error::from_reason(format!(
                "forwardAuc: label at index {i} must be 0 or 1 (got {y})"
            )));
        }
        if y == 1 { pos.push(scores[i]); } else { neg.push(scores[i]); }
    }
    let n1 = pos.len();
    let n0 = neg.len();
    if n1 == 0 && n0 == 0 {
        return Ok(AucResult { auc: None, n: 0, n1: 0, n0: 0, reason: Some("empty".to_string()) });
    }
    if n1 == 0 {
        return Ok(AucResult { auc: None, n: n as u32, n1: 0, n0: n0 as u32, reason: Some("no-positives".to_string()) });
    }
    if n0 == 0 {
        return Ok(AucResult { auc: None, n: n as u32, n1: n1 as u32, n0: 0, reason: Some("no-negatives".to_string()) });
    }
    // I1/I2: pos-major, neg-minor; +1.0 / +0.5 (exact). I3: one divide, n1*n0 as f64 product.
    let mut u = 0.0_f64;
    for i in 0..n1 {
        let p = pos[i];
        for j in 0..n0 {
            let q = neg[j];
            if p > q { u += 1.0; } else if p == q { u += 0.5; }
        }
    }
    Ok(AucResult {
        auc: Some(u / ((n1 as f64) * (n0 as f64))),
        n: n as u32, n1: n1 as u32, n0: n0 as u32, reason: None,
    })
}
```

Cargo.toml: `napi = { version = "3", default-features = false, features = ["napi9"] }` + `napi-derive = "3"`; build-dep `napi-build = "2"`; `[lib] crate-type = ["cdylib"]`. Build: `pnpm --package=@napi-rs/cli dlx napi build --release` (note: `pnpm dlx @napi-rs/cli` fails with ERR_PNPM_DLX_MULTIPLE_BINS — the cli ships `napi` + `napi-raw`, so the `--package=... dlx napi` form is required). The minimal config emitted `<binaryName>.node` + `index.d.ts` but no `index.js` loader — for the real package, either add the loader-generating napi config or `require` the `.node` directly.
