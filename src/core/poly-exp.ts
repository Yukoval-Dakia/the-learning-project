// YUK-495 Phase 0 (decision ②) — shared fixed-polynomial exp / σ.
//
// WHY THIS EXISTS — the determinism gap the catalog/cold-start-sketch flagged:
//   The isomorphic core's bit-exact story (#41/#105) breaks on `Math.exp`. The 1PL
//   ICC σ(x) = 1/(1+exp(-x)) (theta.ts logistic, pfa.ts sigmoid) is the deepest,
//   most-reused primitive in the θ̂/p(L) stack — but `Math.exp` is a libm
//   transcendental NOT specified bit-for-bit by IEEE-754, so Rust `f64::exp`
//   (server, napi) and V8 `Math.exp` (and a WASM build's libm) are NOT guaranteed
//   to return identical bits. Every other op the core uses (+ − × ÷ compare sort
//   floor) IS correctly-rounded per IEEE-754 → identical across V8 / native / wasm.
//
// owner decision ② (2026-06-25): route BOTH the JS oracle AND Rust through ONE
//   shared fixed-coefficient polynomial exp built only from + − × ÷ and an exact
//   power-of-two scale. Then σ itself is `Object.is`-bit-exact across languages —
//   the ULP carve-out is removed; the whole core is literally bit-for-bit.
//
// DETERMINISM CONTRACT (must hold verbatim on BOTH sides — see crates/calibration-native):
//   - IDENTICAL coefficients (exact f64 literals, copied byte-for-byte to Rust).
//   - IDENTICAL Horner order (highest-degree term first, one (acc*r + c) per step).
//   - NO FMA: plain `acc * r + c` (Rust must NOT use f64::mul_add — it rounds once,
//     V8 rounds twice; that single difference would break Object.is).
//   - Range reduction k = floor(x·LOG2E + 0.5): floor is IEEE-exact + identical on
//     both sides. (Math.round / f64::round DISAGREE at exact halves — round-half-up
//     via floor is the portable choice; the tie bias is accuracy-irrelevant here.)
//   - Cody–Waite 2-part ln2 (LN2_HI + LN2_LO) so r = (x − k·LN2_HI) − k·LN2_LO keeps
//     precision; both constants are exact f64 shared verbatim.
//   - 2^k via IEEE exponent-bit construction (exact for k in normal range) — NOT
//     Math.pow / powi (impl-defined), so the scale is provably identical.
//
// This is a PURE function (no IO, cross-subject) and is the always-on JS oracle the
// Rust port (crates/calibration-native poly_exp) is bit-parity-verified against.
// Phase 1 swaps theta.ts `logistic` / pfa.ts `sigmoid` to call `polySigmoid` so the
// live θ̂/p(L) numbers become re-derivable bit-for-bit; this module ships that math.

// Constants are built from their exact IEEE-754 bit patterns (not decimal literals) so
// they are byte-identical to the Rust `f64::from_bits(...)` side with zero
// decimal-parsing ambiguity — the determinism contract for the most rounding-sensitive
// values. (Also sidesteps biome noPrecisionLoss on the long fdlibm decimals.)
function f64FromBits(hex: bigint): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, hex); // big-endian set + get → bit pattern verbatim, endianness-safe
  return dv.getFloat64(0);
}
// log2(e) = 0x3FF71547652B82FE === Math.LOG2E === Rust std::f64::consts::LOG2_E.
const LOG2E = Math.LOG2E;
// Cody–Waite split of ln2: LN2_HI has its low mantissa bits zeroed (0x…FEE00000) so
// k·LN2_HI is exact for the small integer k in range; LN2_LO carries the remainder.
const LN2_HI = f64FromBits(0x3fe62e42fee00000n);
const LN2_LO = f64FromBits(0x3dea39ef35793c76n);

// Taylor coefficients 1/n! for exp(r), r ∈ [−ln2/2, ln2/2] (|r| ≤ 0.3466). Degree 13:
// truncation error ≈ |r|^14/14! ≈ 6e-19 < f64 eps → polyExp is faithful to the last
// few ULP of true exp on the reduced range; accuracy-vs-Math.exp is MEASURED by the
// Phase-0 test (this is decision ②'s "cost of the swap" number). Exact rationals →
// trivially identical in Rust; no minimax-table transcription risk.
const C2 = 1 / 2; // 0.5
const C3 = 1 / 6;
const C4 = 1 / 24;
const C5 = 1 / 120;
const C6 = 1 / 720;
const C7 = 1 / 5040;
const C8 = 1 / 40320;
const C9 = 1 / 362880;
const C10 = 1 / 3628800;
const C11 = 1 / 39916800;
const C12 = 1 / 479001600;
const C13 = 1 / 6227020800;

// 2^k for integer k via IEEE-754 exponent bits — exact, endianness-independent in
// VALUE (the typed-array index is endian-specific; the resulting f64 is 2^k anywhere).
// Mirror of Rust `f64::from_bits(((1023 + k) as u64) << 52)`.
const _scaleBuf = new ArrayBuffer(8);
const _scaleF64 = new Float64Array(_scaleBuf);
const _scaleU32 = new Uint32Array(_scaleBuf);
const _LE = (() => {
  // Detect typed-array byte order once so the high word index is correct.
  _scaleU32[0] = 1;
  return new Uint8Array(_scaleBuf)[0] === 1; // true → little-endian (high word at index 1)
})();
function pow2i(k: number): number {
  const hi = (1023 + k) << 20; // biased exponent into bits 52..62 of the f64
  if (_LE) {
    _scaleU32[1] = hi >>> 0;
    _scaleU32[0] = 0;
  } else {
    _scaleU32[0] = hi >>> 0;
    _scaleU32[1] = 0;
  }
  return _scaleF64[0];
}

/**
 * Shared fixed-polynomial exp(x). Bit-identical to the Rust `poly_exp` port (verified
 * by the calibration-native differential suite via `Object.is`). NOT a drop-in for the
 * full f64 exp domain — guards the σ operating range (|x| ≲ 40) used by the θ̂/p(L)
 * stack; saturates cleanly outside it. Within range, faithful to ~1 ULP of true exp
 * (measured vs Math.exp by the Phase-0 test).
 */
export function polyExp(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  // Saturate the tails (outside the θ̂/p(L) range these feed σ→{0,1} anyway; this also
  // keeps k inside the exact-pow2i exponent window). 708.0 ≈ ln(f64::MAX).
  if (x > 708.0) return Number.POSITIVE_INFINITY;
  if (x < -745.0) return 0.0;

  // Range reduction: x = k·ln2 + r, |r| ≤ ln2/2.  k = round-half-up(x·log2(e)).
  const k = Math.floor(x * LOG2E + 0.5);
  const r = x - k * LN2_HI - k * LN2_LO; // Cody–Waite: two exact-ish subtractions

  // Horner, highest degree first, NO FMA. p = exp(r) ≈ Σ rⁿ/n!.
  let p = C13;
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
  p = p * r + 1.0; // + r¹/1!
  p = p * r + 1.0; // + r⁰/0!

  return p * pow2i(k); // single exact ×2^k
}

/**
 * Shared σ(x) = 1/(1 + polyExp(−x)) — the bit-exact 1PL ICC. Drop-in replacement
 * (decision ②) for theta.ts `logistic` / pfa.ts `sigmoid` so the displayed θ̂/p(L)
 * become re-derivable bit-for-bit (Phase 1 swap). Strictly in (0,1); monotone.
 */
export function polySigmoid(x: number): number {
  return 1 / (1 + polyExp(-x));
}
