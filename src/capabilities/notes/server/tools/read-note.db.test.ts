import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { readNoteTool } from './read-note';

const text = (text: string) => ({ type: 'text', text });
const para = (content: unknown[]) => ({ type: 'paragraph', content });
const block = (id: string, md: string, content: unknown[] = []) => ({
  type: 'semanticBlock',
  attrs: { id, source_markdown: md },
  content,
});
const seed = (id: string, content: unknown[]) =>
  testDb().execute(sql`insert into artifact(id,title,type,intent_source,source,body_blocks,
    created_at,updated_at) values(${id},${id},'note_atomic','learning_intent','ai_generated',
    ${JSON.stringify({ type: 'doc', content })}::jsonb,now(),now())`);
const item = (text: string) => ({ type: 'listItem', content: [para([{ type: 'text', text }])] });

describe('read_note', () => {
  // @invariant security: body_md carries only unretracted content — a retracted child subtree leaves no text behind, not even through its parent's source mirror — while the surviving heading, math and list markdown stays intact; a body past the cap is clipped
  // @fails-if a retracted subtree's text reappears via the parent mirror, surviving nodes flatten to plain text, or a 9000-char body comes back unclipped with body_truncated false
  it('projects the body minus retracted subtrees, then clips at the cap', async () => {
    await resetDb();
    const ctx = { db: testDb(), taskRunId: 't', callerActor: { kind: 'agent' as const, ref: 'x' } };
    const read = async (id: string) => (await readNoteTool.execute(ctx, { note_id: id })).notes[0];
    const tree = block('s1', '定义\n\n子树秘密', [
      { type: 'heading', attrs: { level: 2 }, content: [text('标题甲')] },
      para([text('定义'), { type: 'inlineMath', attrs: { latex: 'a^2' } }]),
      { type: 'bulletList', content: ['LIST_A', 'LIST_B'].map(item) },
      block('s-child', '子树秘密', [para([text('孙块秘密')])]),
    ]);
    await seed('a', [tree]);
    await seed('b', [block('b1', 'x'.repeat(9000))]);
    const retract = { correction_kind: 'retract', block_id: 's-child', reason_md: '撤回' };
    await testDb().execute(sql`insert into event(id,actor_kind,actor_ref,action,subject_kind,
      subject_id,outcome,payload) values('retract','user','self','correct','artifact','a','success',
      ${JSON.stringify(retract)}::jsonb)`);

    expect((await read('a'))?.body_md).toBe('## 标题甲\n\n定义$a^2$\n\n- LIST_A\n- LIST_B');
    expect(await read('b')).toMatchObject({ body_md: 'x'.repeat(8000), body_truncated: true });
  });
});
