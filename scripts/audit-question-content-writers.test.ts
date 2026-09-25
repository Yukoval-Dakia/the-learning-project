// YUK-1043 — 内容列写入闭包审计的自测（scripts/*.test.ts → unit 分区）。
// 钉住：scanner 的判别力（内容列/生命周期列/顶层 spread/嵌套 spread）与
// 登记表的机械不变量（converged ⇒ 引用 publisher；pending ⇒ 有 ticket）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { QUESTION_CONTENT_WRITER_REGISTRY } from '../src/server/questions/writer-registry';
import { CONTENT_COLUMNS, scanSource } from './audit-question-content-writers';

describe('scanSource — 判别力', () => {
  it('flags a content-column INSERT with the exact columns', () => {
    const hits = scanSource(`
      await tx.insert(question).values({
        id, kind: 'choice',
        prompt_md: 'p',
        reference_md: 'r',
        choices_md: ['A'],
      });
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('insert');
    expect(hits[0].contentColumns).toEqual(['prompt_md', 'reference_md', 'choices_md']);
  });

  it('ignores lifecycle/projection-only updates (draft_status / embedding / metadata)', () => {
    const hits = scanSource(`
      await db.update(question).set({ draft_status: 'active', updated_at: now })
        .where(eq(question.id, id));
      await db.update(question).set({ embedding: null, answer_class: 'exact' });
      await db.update(question).set({ metadata: { archived_at: 1 } });
    `);
    expect(hits).toHaveLength(0);
  });

  it('treats a TOP-LEVEL spread payload as a full-surface content write', () => {
    const hits = scanSource(`
      await tx.insert(question).values({ ...questionRow, draft_status: 'draft' });
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0].contentColumns).toEqual([...CONTENT_COLUMNS]);
  });

  it('does NOT widen a nested spread (metadata merge) into a content write', () => {
    const hits = scanSource(`
      await tx.update(question).set({
        metadata: { ...metadataRaw, quiz_gen: failedMeta } as never,
        updated_at: now,
      });
    `);
    expect(hits).toHaveLength(0);
  });

  it('multiple statements are bounded independently (later payload does not leak)', () => {
    const hits = scanSource(`
      await db.insert(question).values({ id, kind });
      await other.insert(foo).values({ prompt_md: 'x' });
    `);
    expect(hits).toHaveLength(0);
  });

  it('content keys inside a .values(kinds.map(cb)) payload are caught — a `;` in the callback body is NOT the statement end', () => {
    // YUK-1043 闭包修正回归：intervention-diagnostics 的诊断 INSERT 曾因窗口在
    // 回调体首个 `;` 截断而整体漏检（§2 矩阵行 16 漏网写口）。
    const hits = scanSource(`
      await tx
        .insert(question)
        .values(
          kinds.map((kind) => {
            const diagnostic = packageValue.diagnostics[kind];
            return {
              id: kind,
              prompt_md: buildPrompt(diagnostic),
              reference_md: diagnostic.probe_spec.reference_md,
              judge_kind_override: 'multimodal_direct',
              metadata: {},
            };
          }),
        )
        .onConflictDoNothing();
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('insert');
    expect(hits[0].contentColumns).toEqual(
      expect.arrayContaining(['prompt_md', 'reference_md', 'judge_kind_override']),
    );
  });
});

describe('writer registry — 机械不变量', () => {
  it('every converged entry references the publisher seam in its real source', () => {
    for (const [file, entry] of Object.entries(QUESTION_CONTENT_WRITER_REGISTRY)) {
      if (entry.status !== 'publisher-converged') continue;
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, `${file} claims converged`).toMatch(/publishQuestionGroup/);
    }
  });

  it('every pending entry carries a ticket and a §2-matrix note', () => {
    for (const [file, entry] of Object.entries(QUESTION_CONTENT_WRITER_REGISTRY)) {
      expect(entry.tickets.length, `${file} needs a ticket`).toBeGreaterThan(0);
      expect(entry.note.length, `${file} needs a disposition note`).toBeGreaterThan(4);
      if (entry.status === 'working-copy-pending') {
        expect(entry.tickets.join(',')).toMatch(/YUK-\d+/);
      }
    }
  });

  it('the three central server seams are converged (YUK-1043 scope)', () => {
    expect(QUESTION_CONTENT_WRITER_REGISTRY['src/server/questions/write.ts']?.status).toBe(
      'publisher-converged',
    );
    expect(
      QUESTION_CONTENT_WRITER_REGISTRY['src/server/questions/sourced-draft-insert.ts']?.status,
    ).toBe('publisher-converged');
    expect(QUESTION_CONTENT_WRITER_REGISTRY['src/server/questions/parts.ts']?.status).toBe(
      'publisher-converged',
    );
  });
});
