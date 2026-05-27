export type JsonNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: unknown[];
};

export type JsonDoc = JsonNode & { type: 'doc'; content: JsonNode[] };

export type MarkWrongStore = Record<string, { status: 'wrong'; reason?: string }>;

export function cloneDoc(doc: JsonDoc): JsonDoc {
  return JSON.parse(JSON.stringify(doc)) as JsonDoc;
}

function firstTextNode(node: JsonNode): JsonNode | null {
  if (typeof node.text === 'string') return node;
  for (const child of node.content ?? []) {
    const found = firstTextNode(child);
    if (found) return found;
  }
  return null;
}

export function getBlockIds(doc: JsonDoc): string[] {
  return (doc.content ?? [])
    .filter((node) => node.type === 'semanticBlock' || node.type === 'artifactRefBlock')
    .map((node) => String(node.attrs?.id ?? ''))
    .filter(Boolean);
}

export function splitSemanticBlockAtEnd(doc: JsonDoc, blockId: string, newBlockId: string): JsonDoc {
  const next = cloneDoc(doc);
  const index = next.content.findIndex(
    (node) => node.type === 'semanticBlock' && node.attrs?.id === blockId,
  );
  if (index === -1) throw new Error(`block ${blockId} not found`);
  const original = next.content[index];
  const splitBlock: JsonNode = {
    type: 'semanticBlock',
    attrs: {
      id: newBlockId,
      semantic_kind: original.attrs?.semantic_kind ?? null,
    },
    content: [{ type: 'paragraph' }],
  };
  next.content.splice(index + 1, 0, splitBlock);
  return next;
}

export function mergeSemanticBlockIntoLeft(doc: JsonDoc, leftId: string, rightId: string): JsonDoc {
  const next = cloneDoc(doc);
  const leftIndex = next.content.findIndex(
    (node) => node.type === 'semanticBlock' && node.attrs?.id === leftId,
  );
  const rightIndex = next.content.findIndex(
    (node) => node.type === 'semanticBlock' && node.attrs?.id === rightId,
  );
  if (leftIndex === -1) throw new Error(`left block ${leftId} not found`);
  if (rightIndex === -1) throw new Error(`right block ${rightId} not found`);
  if (rightIndex !== leftIndex + 1) throw new Error(`${leftId} and ${rightId} are not adjacent`);

  const left = next.content[leftIndex];
  const right = next.content[rightIndex];
  left.content = [...(left.content ?? []), ...(right.content ?? [])];
  next.content.splice(rightIndex, 1);
  return next;
}

export function projectMarkWrong(doc: JsonDoc, store: MarkWrongStore) {
  return getBlockIds(doc).map((block_id) => ({
    block_id,
    wrong: store[block_id]?.status === 'wrong',
  }));
}

export function replaceFirstTextInBlock(doc: JsonDoc, blockId: string, newContent: string): JsonDoc {
  const next = cloneDoc(doc);
  const block = next.content.find((node) => node.attrs?.id === blockId);
  if (!block) throw new Error(`block ${blockId} not found`);
  const text = firstTextNode(block);
  if (text) {
    text.text = newContent;
  } else {
    block.content = [{ type: 'paragraph', content: [{ type: 'text', text: newContent }] }];
  }
  return next;
}

export function assertSplitMergeAndMarkWrong(doc: JsonDoc) {
  const markWrongStore: MarkWrongStore = {
    b_def_1: { status: 'wrong', reason: 'mock mark_wrong before split' },
  };

  const split = splitSemanticBlockAtEnd(doc, 'b_def_1', 'b_def_new');
  const splitProjection = projectMarkWrong(split, markWrongStore);
  const originalHit = splitProjection.find((row) => row.block_id === 'b_def_1');
  const newHit = splitProjection.find((row) => row.block_id === 'b_def_new');
  if (!originalHit?.wrong) throw new Error('mark_wrong did not stay on original id b_def_1');
  if (newHit?.wrong) throw new Error('mark_wrong drifted to the new split block');

  const merged = mergeSemanticBlockIntoLeft(split, 'b_def_1', 'b_def_new');
  const mergedIds = getBlockIds(merged);
  if (!mergedIds.includes('b_def_1')) throw new Error('merge lost original id b_def_1');
  if (mergedIds.includes('b_def_new')) throw new Error('merge kept discarded id b_def_new');

  return {
    before: doc,
    split,
    splitProjection,
    merged,
    mergedProjection: projectMarkWrong(merged, markWrongStore),
  };
}
