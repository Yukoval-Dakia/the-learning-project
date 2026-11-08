import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@/core/ids';
import { artifact, event, knowledge, learning_item } from '@/db/schema';
import { writeLearningItemProposal } from '@/kernel/proposals/producers';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { planLearningIntent } from './learning-intent';

const HUB = { title: '总览', summary_md: '概览。' };
const note = (id: string) => ({ knowledge_id: id, title: '条', one_line_intent: '能分辨。' });
const link = (ids: string[]) => ({
  knowledge_ids: ids,
  title: '综',
  one_line_intent: '能串起来。',
});
const proposed = (tempId: string) => ({ temp_id: tempId, name: tempId, domain: 'yuwen' });

let seq = 0;
function nid(): string {
  seq += 1;
  return `k${seq.toString(36).padStart(11, '0')}`;
}

let raw: ReturnType<typeof postgres> | undefined;
function rawClient(): ReturnType<typeof postgres> {
  if (raw) return raw;
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set — globalSetup did not run');
  raw = postgres(url, { max: 1 });
  return raw;
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

async function seedGraph(root: string, children: string[], extras: string[]): Promise<void> {
  const now = new Date();
  const base = {
    domain: 'yuwen',
    merged_from: [] as string[],
    proposed_by_ai: false,
    approval_status: 'approved' as const,
    created_at: now,
    updated_at: now,
    version: 0,
  };
  await testDb()
    .insert(knowledge)
    .values([
      { ...base, id: root, name: root, parent_id: null },
      ...children.map((id) => ({ ...base, id, name: id, parent_id: root })),
      ...extras.map((id) => ({ ...base, id, name: id, parent_id: null })),
    ]);
}

async function counts(): Promise<{
  knowledge: number;
  items: number;
  artifacts: number;
  proposals: number;
}> {
  const db = testDb();
  const [nodes, items, artifacts, proposals] = await Promise.all([
    db.select({ id: knowledge.id }).from(knowledge),
    db.select({ id: learning_item.id }).from(learning_item),
    db.select({ id: artifact.id }).from(artifact),
    db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.action, 'experimental:propose_learning_intent')),
  ]);
  return {
    knowledge: nodes.length,
    items: items.length,
    artifacts: artifacts.length,
    proposals: proposals.length,
  };
}

async function plan(topic: string, outline: unknown): Promise<string> {
  const proposal = await planLearningIntent({
    db: testDb(),
    topic,
    runTaskFn: async () => ({ text: JSON.stringify(outline) }),
  });
  return proposal.proposal_id;
}

async function store(input: {
  topic: string;
  planCase: '3a_topic_missing' | '3b_children_missing' | '3c_existing_graph';
  rootId: string | null;
  proposed?: {
    root?: { temp_id: string; name: string; domain: string };
    children: { temp_id: string; name: string; domain: string }[];
  };
  atomics: ReturnType<typeof note>[];
  longs?: ReturnType<typeof link>[];
  reviewed?: {
    root: { id: string; parent_id: string | null; version: number };
    children: { id: string; parent_id: string | null; version: number }[];
  };
}): Promise<string> {
  const longs = input.longs ?? [];
  const knowledgeNode = { id: input.rootId ?? 'root', name: input.topic, domain: 'yuwen' };
  return writeLearningItemProposal(testDb(), {
    topic: input.topic,
    plan_case: input.planCase,
    knowledge_node: knowledgeNode,
    ...(input.proposed ? { proposed_knowledge: input.proposed } : {}),
    hub: HUB,
    atomics: input.atomics,
    longs,
    reason_md: '学习路径提议',
    legacy_subject_id: newId(),
    legacy_event_payload: {
      topic: input.topic,
      plan_case: input.planCase,
      knowledge_node_id: input.rootId,
      knowledge_node: knowledgeNode,
      ...(input.proposed ? { proposed_knowledge: input.proposed } : {}),
      ...(input.reviewed ? { reviewed_knowledge: input.reviewed } : {}),
      hub: HUB,
      atomics: input.atomics,
      longs,
    },
    created_at: new Date(),
  });
}

async function moveNode(
  id: string,
  other: string,
  move: 'archive' | 'reparent' | 'merge',
): Promise<void> {
  const db = testDb();
  if (move === 'archive') {
    await db.update(knowledge).set({ archived_at: new Date() }).where(eq(knowledge.id, id));
  } else if (move === 'reparent') {
    await db.update(knowledge).set({ parent_id: other }).where(eq(knowledge.id, id));
  } else {
    await db.update(knowledge).set({ version: 1 }).where(eq(knowledge.id, id));
  }
}

async function planned(): Promise<{
  proposalId: string;
  root: string;
  child: string;
  other: string;
}> {
  const root = nid();
  const child = nid();
  const other = nid();
  await seedGraph(root, [child], [other]);
  const proposalId = await plan(root, { hub: HUB, atomics: [note(child)], longs: [] });
  return { proposalId, root, child, other };
}

async function waitUntilBlocked(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = (await testDb().execute(sql<{ blocked: boolean }>`
      select exists (
        select 1 from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
      ) as blocked
    `)) as Array<{ blocked: boolean }>;
    if (rows[0]?.blocked) return;
    if (Date.now() > deadline) throw new Error('accept never waited on the knowledge row lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('learning intent reference graph', () => {
  beforeEach(() => resetDb());
  afterAll(async () => {
    await raw?.end();
  });

  // @invariant data: a repeated, missing, or unknown learning-intent id is refused at plan and at accept, and an archived, reparented, or version-changed node comes back stale, with no notes written
  // @fails-if a duplicate temp id, a missing atomic, an unknown long, or a moved knowledge row still materializes a learning item or note
  it('refuses a broken reference graph and a moved knowledge row without writing notes', async () => {
    const faults: Array<{ run: () => Promise<unknown>; seeded: number; proposals: number }> = [
      {
        seeded: 0,
        proposals: 0,
        run: () =>
          plan(nid(), {
            knowledge: { root: proposed('root'), children: [proposed('same'), proposed('same')] },
            hub: HUB,
            atomics: [note('same'), note('same')],
            longs: [],
          }),
      },
      {
        seeded: 0,
        proposals: 0,
        run: () =>
          plan(nid(), {
            knowledge: { root: proposed('same'), children: [proposed('same')] },
            hub: HUB,
            atomics: [note('same')],
            longs: [],
          }),
      },
      {
        seeded: 1,
        proposals: 0,
        run: async () => {
          const root = nid();
          await seedGraph(root, [], []);
          await plan(root, {
            knowledge: { children: [proposed('a'), proposed('b')] },
            hub: HUB,
            atomics: [note('a')],
            longs: [],
          });
        },
      },
      {
        seeded: 3,
        proposals: 0,
        run: async () => {
          const root = nid();
          const first = nid();
          const second = nid();
          await seedGraph(root, [first, second], []);
          await plan(root, { hub: HUB, atomics: [note(first), note(first)], longs: [] });
        },
      },
      {
        seeded: 3,
        proposals: 0,
        run: async () => {
          const root = nid();
          const first = nid();
          const second = nid();
          await seedGraph(root, [first, second], []);
          await plan(root, {
            hub: HUB,
            atomics: [note(first), note(second)],
            longs: [link([first, nid()])],
          });
        },
      },
      {
        seeded: 0,
        proposals: 1,
        run: () =>
          store({
            topic: nid(),
            planCase: '3a_topic_missing',
            rootId: null,
            proposed: { root: proposed('same'), children: [proposed('same'), proposed('b')] },
            atomics: [note('b'), note('same')],
          }).then((id) => acceptAiProposal(testDb(), id)),
      },
      {
        seeded: 0,
        proposals: 1,
        run: () =>
          store({
            topic: nid(),
            planCase: '3b_children_missing',
            rootId: nid(),
            proposed: { children: [proposed('a'), proposed('b')] },
            atomics: [note('missing')],
          }).then((id) => acceptAiProposal(testDb(), id)),
      },
      {
        seeded: 0,
        proposals: 1,
        run: () => {
          const root = nid();
          const first = nid();
          const second = nid();
          const reviewed = {
            root: { id: root, parent_id: null, version: 0 },
            children: [first, second].map((id) => ({ id, parent_id: root, version: 0 })),
          };
          return store({
            topic: root,
            planCase: '3c_existing_graph',
            rootId: root,
            atomics: [note(first)],
            reviewed,
          }).then((id) => acceptAiProposal(testDb(), id));
        },
      },
      {
        seeded: 3,
        proposals: 1,
        run: async () => {
          const root = nid();
          const first = nid();
          const second = nid();
          await seedGraph(root, [first, second], []);
          const id = await store({
            topic: root,
            planCase: '3c_existing_graph',
            rootId: root,
            atomics: [note(first)],
          });
          await acceptAiProposal(testDb(), id);
        },
      },
      {
        seeded: 0,
        proposals: 1,
        run: () => {
          const root = nid();
          const child = nid();
          return store({
            topic: root,
            planCase: '3c_existing_graph',
            rootId: root,
            atomics: [note(child)],
            longs: [link([child, nid()])],
            reviewed: {
              root: { id: root, parent_id: null, version: 0 },
              children: [{ id: child, parent_id: root, version: 0 }],
            },
          }).then((id) => acceptAiProposal(testDb(), id));
        },
      },
    ];

    for (const fault of faults) {
      const before = await counts();
      await expect(fault.run()).rejects.toMatchObject({ code: 'invalid_atomic_knowledge_id' });
      const after = await counts();
      expect(after.items).toBe(before.items);
      expect(after.artifacts).toBe(before.artifacts);
      expect(after.knowledge).toBe(before.knowledge + fault.seeded);
      expect(after.proposals).toBe(before.proposals + fault.proposals);
    }

    for (const move of ['archive', 'reparent', 'merge'] as const) {
      const graph = await planned();
      const before = await counts();
      await moveNode(graph.child, graph.other, move);
      await expect(acceptAiProposal(testDb(), graph.proposalId)).rejects.toThrow(/^stale/);
      const after = await counts();
      expect(after.items).toBe(before.items);
      expect(after.artifacts).toBe(before.artifacts);
      const rates = await testDb()
        .select({ payload: event.payload })
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, graph.proposalId)));
      expect(rates.map((row) => (row.payload as { rating?: string }).rating)).toEqual(['rollback']);
    }
  });

  // @invariant concurrency: an accept waiting on the knowledge row lock binds the reviewed ids, or returns stale once archive, reparent, or a version bump commits under that lock
  // @fails-if the accept writes notes after the locked row was archived, reparented, or version-bumped, or binds them to some other id
  it('serializes accept with a knowledge row change held on the same lock', async () => {
    const moves: Array<{
      target: 'child' | 'root';
      apply: ((tx: postgres.TransactionSql, id: string, other: string) => Promise<void>) | null;
    }> = [
      {
        target: 'child',
        apply: async (tx, id) => {
          await tx`update knowledge set archived_at = now() where id = ${id}`;
        },
      },
      {
        target: 'child',
        apply: async (tx, id, other) => {
          await tx`update knowledge set parent_id = ${other} where id = ${id}`;
        },
      },
      {
        target: 'child',
        apply: async (tx, id) => {
          await tx`update knowledge set version = version + 1 where id = ${id}`;
        },
      },
      {
        target: 'root',
        apply: async (tx, id) => {
          await tx`update knowledge set archived_at = now() where id = ${id}`;
        },
      },
      { target: 'child', apply: null },
    ];

    for (const move of moves) {
      const graph = await planned();
      const target = move.target === 'root' ? graph.root : graph.child;
      const held = gate();
      const release = gate();
      const holder = rawClient().begin(async (tx) => {
        await tx`select id from knowledge where id = ${target} for update`;
        held.open();
        await release.promise;
        if (move.apply) await move.apply(tx, target, graph.other);
      });
      try {
        await held.promise;
        const accepting = acceptAiProposal(testDb(), graph.proposalId);
        await waitUntilBlocked();
        release.open();
        if (move.apply) {
          await expect(accepting).rejects.toThrow(/^stale/);
          const items = await testDb()
            .select({ id: learning_item.id })
            .from(learning_item)
            .where(eq(learning_item.source_ref, graph.proposalId));
          const notes = await testDb()
            .select({ id: artifact.id })
            .from(artifact)
            .where(eq(artifact.source_ref, graph.proposalId));
          expect(items).toEqual([]);
          expect(notes).toEqual([]);
        } else {
          expect((await accepting).kind).toBe('learning_item');
          const bound = (
            await testDb()
              .select({ knowledge_ids: learning_item.knowledge_ids })
              .from(learning_item)
              .where(eq(learning_item.source_ref, graph.proposalId))
          )
            .flatMap((row) => row.knowledge_ids)
            .sort();
          expect(bound).toEqual([graph.child, graph.root].sort());
          await testDb()
            .update(knowledge)
            .set({ archived_at: new Date(), parent_id: graph.other, version: 5 })
            .where(eq(knowledge.id, graph.child));
          const after = (
            await testDb()
              .select({ knowledge_ids: learning_item.knowledge_ids })
              .from(learning_item)
              .where(eq(learning_item.source_ref, graph.proposalId))
          )
            .flatMap((row) => row.knowledge_ids)
            .sort();
          expect(after).toEqual(bound);
        }
        await holder;
      } finally {
        release.open();
        await holder.catch(() => undefined);
      }
    }
  }, 60_000);
});
