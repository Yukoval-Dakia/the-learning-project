// Goal, learning_item, mistake_variant, artifact and question_block have canonical editor policy.
// Remaining flags select only writers whose cutover is not retired. Knowledge/edge
// share the global flag; ItemCalibration stays Scheme A (default OFF).
const PER_ENTITY_FLAG_ENV = {
  item_calibration: 'PROJECTION_IS_WRITER_ITEM_CALIBRATION',
} as const;
const CANONICAL_WRITERS = {
  goal: true,
  learning_item: true,
  mistake_variant: true,
  artifact: true,
  question_block: true,
} as const;
export type ProjectionEntity = keyof typeof PER_ENTITY_FLAG_ENV | keyof typeof CANONICAL_WRITERS;

/** Read-only audit policy; business owners do not branch on retired modes. */
export function projectionIsWriter(entity?: ProjectionEntity): boolean {
  if (entity === undefined) return process.env.PROJECTION_IS_WRITER === '1';
  if (entity !== 'item_calibration') return true;
  return process.env[PER_ENTITY_FLAG_ENV[entity]] === '1';
}

/** Printed by both process roles so writer policy can be compared without a new table. */
export function trackedFlagVector(): Record<string, boolean> {
  const vector: Record<string, boolean> = {
    'knowledge+knowledge_edge': projectionIsWriter(),
    ...CANONICAL_WRITERS,
  };
  for (const entity of Object.keys(PER_ENTITY_FLAG_ENV) as (keyof typeof PER_ENTITY_FLAG_ENV)[]) {
    vector[entity] = projectionIsWriter(entity);
  }
  return vector;
}

/** Existing boot entrypoint; canonical writer rollback now requires an older release. */
export function warnFlipOrder(): void {
  console.info('[sot-flag] flag vector at boot:', trackedFlagVector());
}
