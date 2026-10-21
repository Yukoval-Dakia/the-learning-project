// Single verified-block detector shared by the apply guard and the job gate.
// A block is user-owned when explicitly verified or its provenance tier is user_verified.
export function isVerifiedBlock(node: Record<string, unknown>): boolean {
  const attrs = node.attrs;
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) return false;
  const a = attrs as Record<string, unknown>;
  return a.user_verified === true || a.source_tier === 'user_verified';
}
