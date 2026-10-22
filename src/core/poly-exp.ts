// YUK-495 — shared fixed-polynomial exp / σ.
//
// Math.exp is a libm transcendental without a bit-for-bit IEEE-754 contract, so V8,
// Rust f64::exp and WASM can disagree in the last bits. The 1PL ICC is the most reused
// primitive in the θ̂/p(L) stack, so owner decision ② routes both the JS oracle and
// Rust through one polynomial exp built only from + − × ÷ and an exact power-of-two
// scale. The determinism contract on both sides: identical coefficients, identical
// Horner order, no FMA, range reduction k = floor(x·LOG2E + 0.5), Cody–Waite ln2, and
// 2^k from exponent bits. The Rust port is bit-parity-verified against this oracle.
// Phase 1 swaps theta/pfa onto polySigmoid; until then POLY_SIGMOID_ENABLED keeps the
// live Math.exp path.

// Built from exact IEEE-754 bit patterns so the Rust f64::from_bits side matches with
// no decimal-parsing ambiguity (and avoids biome's noPrecisionLoss on long decimals).
function f64FromBits(hex: bigint): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, hex); // big-endian set + get is endianness-safe
  return dv.getFloat64(0);
}
const LOG2E = Math.LOG2E;
// Cody–Waite split: LN2_HI has low mantissa bits zeroed so k·LN2_HI is exact.
const LN2_HI = f64FromBits(0x3fe62e42fee00000n);
const LN2_LO = f64FromBits(0x3dea39ef35793c76n);

// Taylor coefficients 1/n! for |r| ≤ ln2/2. Exact rationals keep the Rust side
// trivially identical; degree 13 truncation is below f64 epsilon on the reduced range.
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

// 2^k from exponent bits: exact and value-endianness-independent. Mirrors the Rust
// f64::from_bits(((1023 + k) as u64) << 52).
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
 * Fixed-polynomial exp, bit-identical to the Rust port. Only valid over the σ range
 * (|x| ≲ 40); outside it the tails saturate cleanly.
 */
export function polyExp(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  // Saturate symmetrically. The lower guard must be −708, not −745: pow2i only builds
  // normal exponents, so below its window it would emit sign-flipped garbage.
  if (x > 708.0) return Number.POSITIVE_INFINITY;
  if (x < -708.0) return 0.0;

  // x = k·ln2 + r, |r| ≤ ln2/2.
  const k = Math.floor(x * LOG2E + 0.5);
  const r = x - k * LN2_HI - k * LN2_LO;

  // Horner, highest degree first, no FMA.
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
  p = p * r + 1.0;
  p = p * r + 1.0;

  return p * pow2i(k);
}

/**
 * σ(x) = 1/(1 + polyExp(−x)), the bit-exact 1PL ICC. Drop-in for the live logistic
 * once the flag flips. Strictly in (0,1) and monotone.
 */
export function polySigmoid(x: number): number {
  return 1 / (1 + polyExp(-x));
}

/**
 * Dark flag for routing live logistic/sigmoid through polySigmoid. False keeps the
 * Math.exp path byte-identical; flipping is owner-in-loop and shifts values by ≤1 ULP.
 */
export const POLY_SIGMOID_ENABLED = false;
