// YUK-228 (S3 Slice B) — subject → Note Agent Skill name resolution + 降级链.
//
// docs/superpowers/plans/2026-06-06-yuk227-s3-image-reachability.md §1.3 / §2 Slice B
//
// Note skill 键 = subject 级（不带 kind/artifact_type）。三个 Note task
// （NoteGenerateTask / NoteVerifyTask / NoteRefineTask）共用同一份规范包，
// 住在 src/subjects/<id>/skills/note-<id>/SKILL.md。handler 传
// ctx.piSkillDocs = await resolveNoteSkillDoc(subjectId)；pi adapter 把
// SKILL.md 正文注入 system prompt（pi 无 filesystem skill loader）。
//
// 目录名带 subject 后缀（note-yuwen / note-math / note-physics）是历史命名惯例；
// YUK-611 起统一按 <subjectId>--<pack> 命名空间化（skill-namespace.ts），
// 跨科同名不再互踩，键 = 命名空间名（本 resolver 经 skill-namespace.ts 拼名）。
// 后缀保留不动——静态 audit（skill-namespace.test.ts）另挡裸名撞车。
//
// 降级链：缺 note-<id> skill 目录 → 返回 undefined → handler 不传 piSkillDocs
// → 现状 prompt 散文回退，never throws。
//
// S2 第二教训（缝隙防御）：本 resolver 只认精确目录名 'note-<subjectId>'；
// resolveQuizGenSkillDocsForSubject 用 startsWith('quiz-gen-') 过滤，两者不冲突。
// 测试矩阵要求双向断言：resolveNoteSkillDoc 不返回 quiz-gen-*，
// resolveQuizGenSkillsForSubject 不返回 note-*。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { namespacedSkillName } from './skill-namespace';

/**
 * Resolve the Note Agent Skill doc for a subject: the resolved SKILL.md body
 * the pi adapter injects into the system prompt. Returns `[{name, body}]` when
 * `src/subjects/<subjectId>/skills/note-<subjectId>/SKILL.md` exists on disk,
 * or `undefined` when no skill pack has been authored for that subject
 * (降级链: caller passes no piSkillDocs → prompt fallback).
 *
 * skillsRoot defaults to <cwd>/src/subjects (the live SoT). Tests inject a
 * fixture root so the resolver works without touching the real on-disk tree.
 */
export async function resolveNoteSkillDoc(
  subjectId: string,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<{ name: string; body: string }[] | undefined> {
  const noteSkillDir = `note-${subjectId}`;
  try {
    const body = await readFile(
      join(skillsRoot, subjectId, 'skills', noteSkillDir, 'SKILL.md'),
      'utf8',
    );
    if (body.length === 0) return undefined;
    return [{ name: namespacedSkillName(subjectId, noteSkillDir), body }];
  } catch {
    return undefined;
  }
}
