import type {
  AtomicProposal,
  ExistingLearningIntentItem,
  LearningIntentPrerequisiteEdge,
  LongProposal,
} from './learning-intent';

export function readStringId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing a knowledge id`);
  }
  return value;
}

export function readAtomics(value: unknown): AtomicProposal[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('proposal is missing atomics');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object')
      throw new Error(`proposal atomic ${index} is not an object`);
    const row = item as AtomicProposal;
    return {
      ...row,
      knowledge_id: readStringId(row.knowledge_id, `atomic ${index}`),
      prerequisite_knowledge_ids: Array.isArray(row.prerequisite_knowledge_ids)
        ? row.prerequisite_knowledge_ids.map((id, idIndex) =>
            readStringId(id, `atomic ${index} prerequisite ${idIndex}`),
          )
        : [],
    };
  });
}

export function readLongs(value: unknown): LongProposal[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('proposal longs is not a list');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object')
      throw new Error(`proposal long ${index} is not an object`);
    const row = item as LongProposal;
    if (!Array.isArray(row.knowledge_ids) || row.knowledge_ids.length === 0) {
      throw new Error(`proposal long ${index} is missing knowledge ids`);
    }
    return {
      ...row,
      knowledge_ids: row.knowledge_ids.map((id, idIndex) =>
        readStringId(id, `long ${index} knowledge id ${idIndex}`),
      ),
      prerequisite_knowledge_ids: Array.isArray(row.prerequisite_knowledge_ids)
        ? row.prerequisite_knowledge_ids.map((id, idIndex) =>
            readStringId(id, `long ${index} prerequisite ${idIndex}`),
          )
        : [],
    };
  });
}

export function readExistingItems(value: unknown): ExistingLearningIntentItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('proposal existing_items is not a list');
  return value.map((item, index) => {
    const row = item as Partial<ExistingLearningIntentItem>;
    return {
      knowledge_id: readStringId(row.knowledge_id, `existing item ${index} knowledge_id`),
      item_id: readStringId(row.item_id, `existing item ${index} item_id`),
      note_id: readStringId(row.note_id, `existing item ${index} note_id`),
      title: typeof row.title === 'string' && row.title.length > 0 ? row.title : '已有学习项',
    };
  });
}

export function readPrerequisiteEdges(value: unknown): LearningIntentPrerequisiteEdge[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('proposal prerequisite_edges is not a list');
  return value.map((item, index) => {
    const row = item as Partial<LearningIntentPrerequisiteEdge>;
    return {
      prerequisite_knowledge_id: readStringId(
        row.prerequisite_knowledge_id,
        `prerequisite edge ${index} prerequisite_knowledge_id`,
      ),
      dependent_knowledge_id: readStringId(
        row.dependent_knowledge_id,
        `prerequisite edge ${index} dependent_knowledge_id`,
      ),
    };
  });
}
