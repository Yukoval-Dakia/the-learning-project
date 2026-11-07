// One signal envelope for a knowledge-point reading. An unknown is null with a
// reason. A known null is a real absence (no due card). A known zero is a real
// zero. Callers do not invent a number for a missing reading.

export type KnowledgeSignal<T> = {
  value: T | null;
  known: boolean;
  source: string;
  asOf: string;
  missingReason: string | null;
};

export function knownSignal<T>(value: T, source: string, asOf: Date): KnowledgeSignal<T> {
  return {
    value,
    known: true,
    source,
    asOf: asOf.toISOString(),
    missingReason: null,
  };
}

/** The read succeeded and the thing is absent. Not an unknown and not a zero. */
export function absentSignal<T>(source: string, asOf: Date): KnowledgeSignal<T> {
  return {
    value: null,
    known: true,
    source,
    asOf: asOf.toISOString(),
    missingReason: null,
  };
}

export function unknownSignal<T>(
  source: string,
  asOf: Date,
  missingReason: string,
): KnowledgeSignal<T> {
  return {
    value: null,
    known: false,
    source,
    asOf: asOf.toISOString(),
    missingReason,
  };
}
