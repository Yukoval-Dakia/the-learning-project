import { createId } from '@paralleldrive/cuid2';
import { beforeEach, expect, it } from 'vitest';

import { db } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import { findTreeMeshOverlaps } from '../../../../scripts/audit-tree-mesh-overlap';
import { resetDb } from '../../../../tests/helpers/db';

beforeEach(async () => {
  await resetDb();
});

it('reports only live prerequisite edges that duplicate a direct tree link', async () => {
  const now = new Date();
  const parent = createId();
  const child = createId();
  const other = createId();
  await db.insert(knowledge).values([
    { id: parent, name: 'parent', parent_id: null, created_at: now, updated_at: now },
    { id: child, name: 'child', parent_id: parent, created_at: now, updated_at: now },
    { id: other, name: 'other', parent_id: null, created_at: now, updated_at: now },
  ]);
  await db.insert(knowledge_edge).values([
    {
      id: 'overlap',
      from_knowledge_id: child,
      to_knowledge_id: parent,
      relation_type: 'prerequisite',
      created_by: { by: 'user' },
      created_at: now,
    },
    {
      id: 'unrelated',
      from_knowledge_id: parent,
      to_knowledge_id: other,
      relation_type: 'prerequisite',
      created_by: { by: 'user' },
      created_at: now,
    },
    {
      id: 'wrong_relation',
      from_knowledge_id: parent,
      to_knowledge_id: child,
      relation_type: 'related_to',
      created_by: { by: 'user' },
      created_at: now,
    },
  ]);

  await expect(findTreeMeshOverlaps(db)).resolves.toEqual([
    {
      edge_id: 'overlap',
      from_knowledge_id: child,
      to_knowledge_id: parent,
      tree_child_id: child,
      tree_parent_id: parent,
    },
  ]);
});
