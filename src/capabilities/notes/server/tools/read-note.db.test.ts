import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { readNoteTool } from './read-note';

const seed = (id: string, content: unknown[]) =>
  testDb().execute(
    sql`insert into artifact(id,title,type,intent_source,source,body_blocks,created_at,updated_at) values(${id},${id},'note_atomic','learning_intent','ai_generated',${JSON.stringify({ type: 'doc', content })}::jsonb,now(),now())`,
  );
const retract = (id: string, blockId: string) =>
  testDb().execute(
    sql`insert into event(id,actor_kind,actor_ref,action,subject_kind,subject_id,outcome,payload) values('retract','user','self','correct','artifact',${id},'success',${JSON.stringify({ correction_kind: 'retract', block_id: blockId, reason_md: '撤回' })}::jsonb)`,
  );
const t = (text: string) => ({ type: 'text', text });
const n = (type: string, attrs: object, content: unknown[] = []) => ({ type, attrs, content });
const li = (s: string) => n('listItem', {}, [n('paragraph', {}, [t(s)])]);
const block = (id: string, md: string, content: unknown[]) =>
  n('semanticBlock', { id, source_markdown: md }, content);

describe('read_note', () => {
  // @invariant security: body_md carries only unretracted content — a retracted child subtree leaves no text behind, not even through its parent's source mirror — while the surviving heading, math and list markdown stays intact; with nothing retracted it is the blocks' joined mirrors, clipped past 8000 chars
  // @fails-if a retracted subtree's text reappears via the parent mirror, surviving nodes flatten to plain text, or a 9000-char body comes back unclipped with body_truncated false
  it('projects the body minus retracted subtrees, then clips at the cap', async () => {
    await resetDb();
    const ctx = { db: testDb(), taskRunId: 't', callerActor: { kind: 'agent' as const, ref: 'x' } };
    const note = (id: string) => readNoteTool.execute(ctx, { note_id: id });
    const tree = block('s1', '定义\n\n子树秘密', [
      n('heading', { level: 2 }, [t('标题甲')]),
      n('paragraph', {}, [t('定义'), n('inlineMath', { latex: 'a^2' })]),
      n('bulletList', {}, ['LIST_A', 'LIST_B'].map(li)),
      block('s-child', '子树秘密', [n('paragraph', {}, [t('孙块秘密')])]),
    ]);
    await seed('a', [tree]);
    await seed('b', [block('b1', '第一段', []), block('b2', 'x'.repeat(9000), [])]);
    await retract('a', 's-child');

    expect((await note('a')).notes[0]?.body_md).toBe(
      '## 标题甲\n\n定义$a^2$\n\n- LIST_A\n- LIST_B',
    );
    expect((await note('b')).notes[0]).toMatchObject({
      body_md: `第一段\n\n${'x'.repeat(7995)}`,
      body_truncated: true,
    });
  });
});
