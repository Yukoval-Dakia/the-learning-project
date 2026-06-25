# YUK-495 Phase 0 — WASM spike + shared-polynomial exp/σ (de-risk findings)

- **Status**: Phase-0 spike COMPLETE (de-risk only — ships no product feature). Companion to the beachhead (`2026-06-24-rust-napi-calibration-beachhead.md`), the cold-start sketch (`2026-06-25-coldstart-diagnostic-coach-sketch.md`), and the triage (`2026-06-25-rust-catalog-triage.md`).
- **Linear**: YUK-495 (Phase 0+ umbrella), project "Rust 同构核心 — 确定性 cold-start 引擎". `Refs YUK-495`.
- **Goal**: retire the two unknowns gating the isomorphic-core bet before any Phase-1 UI: **U1** does the core run bit-exactly in WASM, and **U2** does owner decision-② (shared-polynomial exp) actually make σ bit-for-bit across languages, and at what accuracy cost.

---

## U2 — shared-polynomial exp/σ (decision ②) — ✅ PROVEN (the load-bearing result)

The deepest determinism risk: σ(x)=1/(1+exp(-x)) (theta.ts `logistic`, pfa.ts `sigmoid`) routes through `Math.exp`, a libm transcendental **not** specified bit-for-bit by IEEE-754 — so Rust `f64::exp` (napi), V8 `Math.exp`, and a WASM libm need not agree. Every other op the core uses (+ − × ÷ compare sort floor) IS correctly-rounded by IEEE-754 → identical across V8/native/wasm.

**Built** (`src/core/poly-exp.ts` ↔ `crates/calibration-native` `poly_exp`/`poly_sigmoid`): one fixed-coefficient polynomial exp from + − × ÷ and an exact power-of-two scale only — Cody–Waite 2-part ln2 range reduction, degree-13 Taylor (1/n!) Horner, 2^k via IEEE exponent-bit construction. Constants built from exact bit patterns (`f64FromBits` / `f64::from_bits`) — no decimal-parse ambiguity. NO FMA (plain `p*r+c` both sides).

**Result 1 — JS↔Rust bit-parity (`src/core/poly-exp-parity.unit.test.ts`, 3/3):** `polyExp` and `polySigmoid` are `Object.is`-equal between V8 and the Rust addon across a stress grid (σ range at 0.01 step; range-reduction boundaries k·ln2 ± ε and the half-way k-flip points; ±0, NaN, ±Inf, sub-normals, tails; realistic `pLearnedBand` inputs pointLogit±se; 1000 seeded random draws). **σ is now bit-for-bit across languages → decision ②'s "no ULP carve-out, whole core literally bit-exact" holds.**

**Result 2 — accuracy vs `Math.exp` (`src/core/poly-exp.unit.test.ts`, 5/5) = the swap cost:**

| comparison | over | max ULP | max abs / rel |
|---|---|---|---|
| `polyExp` vs `Math.exp` | x ∈ [−40, 40] | **1 ULP** | rel 2.22e-16 |
| `polySigmoid` vs live `1/(1+Math.exp(-x))` | x ∈ [−25, 25] | 2 ULP | **abs 2.22e-16** |

> **The cost of swapping the live sigmoid (Phase 1) is ≤1 ULP — invisible at any UI precision.** Bit-exactness is essentially free. `polyExp(0)=1` and `polySigmoid(0)=0.5` are exact; σ is strictly in (0,1), monotone, and symmetric to <1e-12.

**Phase-1 action**: swap theta.ts `logistic` + pfa.ts `sigmoid` to call `polySigmoid` (dark-ship behind a flag with a byte-identical-off regression anchor on θ̂/p(L)), then #41's recompute badge re-derives the displayed numbers bit-for-bit.

---

## U1 — WASM target — ✅ build de-risked; execution-parity = Phase-1 plumbing (not a determinism risk)

**Proven:**
- The existing napi crate compiles to **`wasm32-wasip1` AND `wasm32-wasip1-threads` UNCHANGED** — no wasm-bindgen rewrite; the same `#[napi]` source targets both napi (.node) and WASM. 146 KB `.wasm`.
- Toolchain recipe (reproducible in minutes):
  ```
  rustup target add wasm32-wasip1-threads
  # crate-local devDeps (private crate, dev/CI-only — keeps the root/web prod tree clean):
  #   @emnapi/core @emnapi/runtime @napi-rs/wasm-runtime
  cd crates/calibration-native && napi build --release --target wasm32-wasip1-threads --platform
  #   → emits calibration-native.wasm + index.js (platform dispatcher) + index.d.ts
  ```

**Finding (the de-risk payoff):** napi v3 **hard-links `futures`** (the napi1→napi9 feature chain pulls it; no toggle), so the WASM module emits `emnapi_async_worker_init` requiring the WASI **threads** loader (shared memory + a Worker). A bare synchronous `instantiateNapiModuleSync` fails with `immutable global cannot be assigned`. The `.wasi.cjs` runtime loader that the generated `index.js` dispatches to is **not emitted by bare `napi build`** — it comes from napi's `create-npm-dirs`/publish flow.

**Why execution-parity is deferred, not a risk:** the WASM-vs-native bit question reduces to whether wasm32 f64 ops equal V8/native f64 ops. For every op the core uses (+ − × ÷ compare sort floor) the answer is **yes by IEEE-754** (correctly-rounded, identical). The one non-IEEE op — `exp` — is exactly what U2's polynomial **rebuilds from + − × ÷**, and U2 proved that bit-exact JS↔Rust. So the WASM execution-parity harness is loader *packaging*, deferred to Phase 1 when the `.wasi.cjs` loader ships for real (and is exercised by a test).

**Phase-1 actions:** (a) set up the crate's npm packaging so `napi build` emits the `.wasi.cjs` + `wasi-worker.mjs` loaders (or hand-write them); (b) run the existing native-parity grid against the WASM build to close execution-parity empirically; (c) decide final dep placement — `@napi-rs/wasm-runtime` + `@emnapi/runtime` become **web-bundle runtime deps** when #41's WASM ships to the browser, `@emnapi/core` stays build-only. **Q1 NAS arch** only matters if WASM is ever served from the server image — browser WASM is a build-time artifact.

---

## Invariants locked (carry into every Phase-0+ PR)

Identical coefficients + identical Horner order + **no FMA** (`f64::mul_add` banned) + floor-based range reduction (`floor(x·LOG2E+0.5)` — `round` disagrees at ties) + Cody–Waite 2-part ln2 + 2^k via exponent bits + constants from `from_bits` (no decimal ambiguity). The 1000s of grid points passing `Object.is` is the empirical guarantee these hold (incl. that Rust did not auto-contract to FMA under `lto=true`).

## Adversarial review (independent opus, 2026-06-25)

Verdict **SHIP-WITH-NITS**; could NOT break bit-parity across **8.2M+ `Object.is` comparisons** (floor-tie windows at every k·ln2, saturation boundaries, denormal exponents, exact powers, ±0/±Inf/NaN/MIN/MAX, 2M-point seeded sweep) — **zero divergences**. FMA absence confirmed by **aarch64 disassembly** (17 `fmul`+17 `fadd`, zero `fmadd`) + Rust's no-contract default; `pow2i` construction parity confirmed over k∈[−1100,1100]. **One real finding fixed**: the original `−745` lower guard was too loose — `pow2i` builds only NORMAL exponents, so `polyExp(x)` for x ≲ −709 returned sign-flipped garbage (bit-identical both sides, so parity held; dormant — no live callers, σ-wrapper safe). Fixed to a symmetric **−708** guard + a no-sign-flip regression test; the "keeps k inside the exact-pow2i window" comment is now true on both sides.

## Gate (this spike)

cargo build (release) ✓ · biome (3 new TS files) clean ✓ · full `pnpm typecheck` ✓ · `poly-exp.unit.test.ts` 5/5 ✓ · `poly-exp-parity.unit.test.ts` 3/3 ✓ · native-parity regression 12/12 (unchanged) ✓ · `audit:partition` no P0 (2 pre-existing P1 WARNs unrelated) ✓. The `.node` is opt-in/dev-CI-only (gitignored); the poly TS module is the always-on path.
