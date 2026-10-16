// YUK-1497 — pairing rules shared by matching_columns and ordering (presentation spec §1.2, §1.2.1).
// A relation item is one stable item_id standing for a pair of axis values (left/right, or
// position/object). The learner's answer is the set of item_ids they linked. This file only knows
// which pairs exist and the at-most-per-coordinate limits; it never knows the key.

export type Side = 'a' | 'b';

export interface RelationItem {
  /** Stable item_id that goes into the answer. */
  id: string;
  /** Value on the first axis (left / position). */
  a: string;
  /** Value on the second axis (right / object). */
  b: string;
}

/** at_most_per_coordinate for the two axes; undefined = no limit. */
export interface RelationLimits {
  a?: number;
  b?: number;
}

export type LinkResult =
  | { kind: 'linked'; next: string[]; replaced: RelationItem[] }
  | { kind: 'unlinked'; next: string[] }
  | { kind: 'unavailable' }
  | {
      kind: 'full';
      /** The side whose limit would be exceeded. */
      side: Side;
      /** Pairs already holding that value, in answer order. */
      holders: RelationItem[];
      /** The answer if the learner confirms: the oldest holders give way to the new pair. */
      forced: string[];
    };

export const other = (side: Side): Side => (side === 'a' ? 'b' : 'a');

/** The pairs currently in the answer, in universe order; ids outside the universe are dropped. */
export function linkedItems(items: RelationItem[], value: string[]): RelationItem[] {
  const chosen = new Set(value);
  return items.filter((item) => chosen.has(item.id));
}

export function findPair(items: RelationItem[], a: string, b: string): RelationItem | undefined {
  return items.find((item) => item.a === a && item.b === b);
}

/** Answer order is universe order, so the same pairs always produce the same envelope. */
function canonical(items: RelationItem[], ids: Iterable<string>): string[] {
  const keep = new Set(ids);
  return items.filter((item) => keep.has(item.id)).map((item) => item.id);
}

/**
 * Link `armed` (on `armedSide`) with `target` (on the other side).
 * - Linking an existing pair removes it.
 * - When the armed value is already at a limit of 1, its old pair is replaced: the learner picked
 *   that value on purpose, so re-pairing it is the intent.
 * - When the target value is at its limit, nothing changes yet; the caller shows the holders and
 *   offers `forced`.
 */
export function link(
  items: RelationItem[],
  value: string[],
  armedSide: Side,
  armed: string,
  target: string,
  limits: RelationLimits,
): LinkResult {
  const a = armedSide === 'a' ? armed : target;
  const b = armedSide === 'a' ? target : armed;
  const pair = findPair(items, a, b);
  if (!pair) return { kind: 'unavailable' };
  const current = linkedItems(items, value);
  if (current.some((item) => item.id === pair.id)) {
    return {
      kind: 'unlinked',
      next: canonical(
        items,
        value.filter((id) => id !== pair.id),
      ),
    };
  }

  const targetSide = other(armedSide);
  let kept = current;
  let replaced: RelationItem[] = [];

  const armedHolders = kept.filter((item) => item[armedSide] === armed);
  const armedLimit = limits[armedSide];
  if (armedLimit !== undefined && armedHolders.length >= armedLimit) {
    if (armedLimit === 1) {
      replaced = armedHolders;
      kept = kept.filter((item) => item[armedSide] !== armed);
    } else {
      return full(items, value, kept, armedSide, armedHolders, armedLimit, pair);
    }
  }

  const targetHolders = kept.filter((item) => item[targetSide] === target);
  const targetLimit = limits[targetSide];
  if (targetLimit !== undefined && targetHolders.length >= targetLimit) {
    return full(items, value, kept, targetSide, targetHolders, targetLimit, pair);
  }

  return {
    kind: 'linked',
    next: canonical(items, [...kept.map((item) => item.id), pair.id]),
    replaced,
  };
}

function full(
  items: RelationItem[],
  value: string[],
  kept: RelationItem[],
  side: Side,
  holders: RelationItem[],
  limit: number,
  pair: RelationItem,
): LinkResult {
  // Oldest first: the order the learner made them, as far as the controlled value tells.
  const order = new Map(value.map((id, index) => [id, index]));
  const byAge = [...holders].sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  const evict = new Set(byAge.slice(0, holders.length - limit + 1).map((item) => item.id));
  return {
    kind: 'full',
    side,
    holders: byAge,
    forced: canonical(items, [
      ...kept.filter((item) => !evict.has(item.id)).map((item) => item.id),
      pair.id,
    ]),
  };
}

/** Remove every pair that uses `value` on `side`. */
export function unlinkAll(
  items: RelationItem[],
  value: string[],
  side: Side,
  axisValue: string,
): string[] {
  return linkedItems(items, value)
    .filter((item) => item[side] !== axisValue)
    .map((item) => item.id);
}
