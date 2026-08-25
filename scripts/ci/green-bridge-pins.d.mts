export type Violation = {
  code: string;
  message: string;
  expected?: string;
  actual?: string;
};

export const IMAGE_STATE_PENDING: 'image_digest_pending_publication';
export const IMAGE_STATE_PUBLISHED: 'image_digest_published';

export type PinFreshnessRecord = {
  schema_version: 1;
  mode: 'pins';
  status: 'ok' | 'failed';
  pins: Record<string, string | number | null>;
  violations: Violation[];
};

export function violation(
  code: string,
  message: string,
  expected?: string,
  actual?: string,
): Violation;

export function parsePins(pinsText: string): {
  pins: Record<string, string>;
  violations: Violation[];
};

export function validatePins(input: { pinsText: string; now?: Date }): {
  pins: Record<string, string>;
  violations: Violation[];
  record: PinFreshnessRecord;
};
