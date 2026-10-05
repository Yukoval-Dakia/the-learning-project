// YUK-1043 — 内容列写入闭包审计的自测（scripts/*.test.ts → unit 分区）。
// 钉住：scanner 的判别力（内容列/生命周期列/顶层 spread/嵌套 spread/map 回调/
// shorthand/裸标识符载荷/别名表/原生 SQL/注释免疫）与登记表的机械不变量
//（converged ⇒ 逐写点 seam 调用 + 真实内容写；pending ⇒ 有 ticket + pendingClass）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { QUESTION_CONTENT_WRITER_REGISTRY } from '../src/server/questions/writer-registry';
import {
  CONTENT_COLUMNS,
  blankComments,
  scanSource,
  siteEnclosingFunctionHasSeam,
} from './audit-question-content-writers';

describe('scanSource — 判别力', () => {
  it('flags a content-column INSERT with the exact columns', () => {
    const hits = scanSource(`
      await tx.insert(question).values({
        id, kind: 'choice',
        prompt_md: 'p',
        reference_md: 'r',
        choices_md: ['A'],
      });
    `).findings;
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('insert');
    expect(hits[0].contentColumns).toEqual(['prompt_md', 'reference_md', 'choices_md']);
  });

  it('ignores lifecycle/projection-only updates (draft_status / embedding / metadata)', () => {
    const { findings, violations } = scanSource(`
      await db.update(question).set({ draft_status: 'active', updated_at: now })
        .where(eq(question.id, id));
      await db.update(question).set({ embedding: null, answer_class: 'exact' });
      await db.update(question).set({ metadata: { archived_at: 1 } });
    `);
    expect(findings).toHaveLength(0);
    expect(violations).toHaveLength(0);
  });

  it('treats a TOP-LEVEL spread payload as a full-surface content write', () => {
    const hits = scanSource(`
      await tx.insert(question).values({ ...questionRow, draft_status: 'draft' });
    `).findings;
    expect(hits).toHaveLength(1);
    expect(hits[0].contentColumns).toEqual([...CONTENT_COLUMNS]);
  });

  it('does NOT widen a nested spread (metadata merge) into a content write', () => {
    const { findings, violations } = scanSource(`
      await tx.update(question).set({
        metadata: { ...metadataRaw, quiz_gen: failedMeta } as never,
        updated_at: now,
      });
    `);
    expect(findings).toHaveLength(0);
    expect(violations).toHaveLength(0);
  });

  it('multiple statements are bounded independently (later payload does not leak)', () => {
    const { findings } = scanSource(`
      await db.insert(question).values({ id, kind });
      await other.insert(foo).values({ prompt_md: 'x' });
    `);
    expect(findings).toHaveLength(0);
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
    `).findings;
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('insert');
    expect(hits[0].contentColumns).toEqual(
      expect.arrayContaining(['prompt_md', 'reference_md', 'judge_kind_override']),
    );
  });

  // ── 复审 P1-7 — 曾绕过扫描器的写形 ──

  // ── 第二轮复审 P1-4 — 仍绕过扫描器的写形（先红后绿的回归钉） ──

  it('P1-4r2: call-expression payload (.set(buildPatch())) is UNRESOLVED_PAYLOAD', () => {
    const { findings, violations } = scanSource(`
      await db.update(question).set(buildPatch()).where(eq(question.id, id));
    `);
    expect(findings).toHaveLength(0);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('UNRESOLVED_PAYLOAD');
  });

  it('P1-4r2: member-access payload (.set(input.patch)) is UNRESOLVED_PAYLOAD', () => {
    const { findings, violations } = scanSource(`
      await db.update(question).set(input.patch).where(eq(question.id, id));
    `);
    expect(findings).toHaveLength(0);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('UNRESOLVED_PAYLOAD');
  });

  it('P1-4r2: as-cast payload (.set(patch as Partial<typeof ...>)) is UNRESOLVED_PAYLOAD', () => {
    const { findings, violations } = scanSource(
      'await db.update(question).set(patch as Partial<typeof question.$inferInsert>);',
    );
    expect(findings).toHaveLength(0);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('UNRESOLVED_PAYLOAD');
  });

  it('P1-4r2: wrapper around an identifier-spread object (withAnswerClass({ ...row })) is a FULL-SURFACE content write', () => {
    const { findings, violations } = scanSource(`
      await tx.insert(question).values(
        withAnswerClass({ ...row }),
      );
    `);
    expect(violations).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].contentColumns).toEqual([...CONTENT_COLUMNS]);
  });

  it('P1-4r2: schema-qualified raw SQL (UPDATE public.question) is flagged', () => {
    const { violations } = scanSource(
      "await db.execute(sql`UPDATE public.question SET prompt_md = 'x'`);",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('RAW_SQL');
  });

  it('P1-4r2: per-site coverage does NOT cross function boundaries (bypass() vs unrelated())', () => {
    const src = [
      'async function bypass(tx) {',
      '  await tx.update(question).set({ prompt_md: "p" });',
      '}',
      'async function unrelated(tx) {',
      '  await publishQuestionGroupFromRow(tx, { rootId: 1, actorRef: "x", now: new Date() });',
      '}',
    ].join('\n');
    const { findings } = scanSource(src);
    expect(findings).toHaveLength(1);
    const bypassSite = findings[0].offset;
    // bypass() 自己的函数体内没有 seam 调用 ⇒ 未覆盖（unrelated() 不算）。
    expect(siteEnclosingFunctionHasSeam(src, bypassSite)).toBe(false);
  });

  it('P1-4r2: per-site coverage passes when the SAME function dominates a seam call', () => {
    const src = [
      'async function writer(tx) {',
      '  await tx.update(question).set({ prompt_md: "p" });',
      '  await publishQuestionGroupFromRow(tx, { rootId: 1, actorRef: "x", now: new Date() });',
      '}',
    ].join('\n');
    const { findings } = scanSource(src);
    expect(findings).toHaveLength(1);
    expect(siteEnclosingFunctionHasSeam(src, findings[0].offset)).toBe(true);
  });

  it('P1-7: shorthand object payload ({ prompt_md }) is flagged', () => {
    const { findings, violations } = scanSource(`
      const prompt_md = 'p';
      await db.update(question).set({ prompt_md, updated_at: now });
    `);
    expect(violations).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].contentColumns).toContain('prompt_md');
  });

  it('P1-7: bare-identifier payload (.set(patch)) is UNRESOLVED_PAYLOAD (fail-closed)', () => {
    const { findings, violations } = scanSource(`
      await db.update(question).set(patch).where(eq(question.id, id));
    `);
    expect(findings).toHaveLength(0);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('UNRESOLVED_PAYLOAD');
  });

  it('P1-7: wrapper-call payload (withAnswerClass({...})) is literal — object visible in-window', () => {
    const { findings, violations } = scanSource(`
      await tx.insert(question).values(
        withAnswerClass({
          id: newQuestionId,
          kind: 'short_answer',
          prompt_md: 'p',
          reference_md: null,
        }),
      );
    `);
    expect(violations).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].contentColumns).toContain('prompt_md');
  });

  it('P1-7: question-ish unresolved table identifier (.update(q)) is UNRESOLVED_TABLE', () => {
    const { findings, violations } = scanSource(`
      await db.update(q).set({ prompt_md: 'x' });
    `);
    expect(findings).toHaveLength(0);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('UNRESOLVED_TABLE');
  });

  it('P1-7: aliased schema import (question as q) resolves and flags content writes', () => {
    // P1-5 —— fixture 的 import 说明符动态拼接（不以字面 `@/db/schema` 出现在
    // 本文件源内），否则 partition 审计会把 fixture 文本当真实 DB import 读。、
    const SCHEMA_SPEC = `@${'/db'}/schema`;
    const src = `
      import { question as q, event } from '${SCHEMA_SPEC}';
      await tx.insert(q).values({ id, prompt_md: 'p' });
      await tx.update(event).set({ outcome: 'success' });
    `;
    const { findings, violations } = scanSource(src);
    expect(violations).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].contentColumns).toContain('prompt_md');
  });

  it('P1-7: raw SQL UPDATE question / INSERT INTO question is flagged', () => {
    const { violations } = scanSource(`
      await db.execute(sql\`UPDATE question SET prompt_md = 'x' WHERE id = 'q1'\`);
      await db.execute(sql\`insert into question (id) values ('q2')\`);
    `);
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.code === 'RAW_SQL')).toBe(true);
  });

  it('P1-7: comments are immune — `.insert(question)` / "update question rows" in comment prose is NOT a write site', () => {
    const { findings, violations } = scanSource(`
      // Lock order: advisory → proposal_decision → question rows (sorted).
      // NOTE: the INSERT_HEAD_RE tolerates .insert(question) chained calls —
      /* keep those two adjacent */
      await db.update(question).set({ draft_status: 'draft' });
    `);
    expect(violations).toHaveLength(0);
    expect(findings).toHaveLength(0);
  });

  it('P1-7: blankComments preserves offsets (line/column stability)', () => {
    const src = `const a = 1; // comment .insert(question)\nconst b = 2;\n/* block\ncomment */ const c = 3;`;
    const blanked = blankComments(src);
    expect(blanked.length).toBe(src.length);
    expect(blanked.split('\n').length).toBe(src.split('\n').length);
    expect(blanked).not.toContain('.insert(question)');
    expect(blanked).toContain('const b = 2;');
  });
});

describe('writer registry — 机械不变量', () => {
  it('every converged entry references the publisher seam in its real source (per-site validated by the audit)', () => {
    for (const [file, entry] of Object.entries(QUESTION_CONTENT_WRITER_REGISTRY)) {
      if (entry.status !== 'publisher-converged') continue;
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, `${file} claims converged`).toMatch(/publishQuestionGroup/);
    }
  });

  it('every pending entry carries a ticket, a disposition note AND an explicit pendingClass (P1-6)', () => {
    for (const [file, entry] of Object.entries(QUESTION_CONTENT_WRITER_REGISTRY)) {
      expect(entry.tickets.length, `${file} needs a ticket`).toBeGreaterThan(0);
      expect(entry.note.length, `${file} needs a disposition note`).toBeGreaterThan(4);
      if (entry.status === 'working-copy-pending') {
        expect(entry.tickets.join(','), `${file} pending needs a YUK ticket`).toMatch(/YUK-\d+/);
        expect(
          entry.pendingClass,
          `${file} pending needs pendingClass ('blocked-by' | 'deferred' | 'cutover' | 'rehearsal-only')`,
        ).toMatch(/^(cutover|deferred|blocked-by:YUK-\d+|rehearsal-only)$/);
      }
    }
  });

  it('the central server seams are converged (YUK-1043 scope)', () => {
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
