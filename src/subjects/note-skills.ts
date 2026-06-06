// YUK-228 (S3 Slice B) — subject → Note Agent Skill name resolution + 降级链.
//
// docs/superpowers/plans/2026-06-06-yuk227-s3-image-reachability.md §1.3 / §2 Slice B
//
// Note skill 键 = subject 级（不带 kind/artifact_type）。三个 Note task
// （NoteGenerateTask / NoteVerifyTask / NoteRefineTask）共用同一份规范包，
// 住在 src/subjects/<id>/skills/note/SKILL.md。runner 在进程启动时一次性
// mirror src/subjects/<id>/skills/* 到隔离 CLAUDE_CONFIG_DIR/skills（含
// note/ 目录）；handler 传 ctx.skills = resolveNoteSkill(subjectId) 来
// 白名单激活这一个 skill。
//
// 降级链：缺 note skill 目录 → 返回 undefined → handler 不传 skills 选项
// → runner 走 skills ?? [] 显式禁用 → 现状 prompt 散文回退，never throws。
//
// S2 第二教训（缝隙防御）：本 resolver 只认精确目录名 'note'；
// resolveQuizGenSkillsForSubject 用 startsWith('quiz-gen-') 过滤，两者不冲突。
// 测试矩阵要求双向断言：resolveNoteSkill 不返回 quiz-gen-*，
// resolveQuizGenSkillsForSubject 不返回 note。

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const NOTE_SKILL_DIR = 'note';

/**
 * Resolve the Note Agent Skill whitelist for a subject. Returns `['note']` when
 * `src/subjects/<subjectId>/skills/note/SKILL.md` exists on disk, or `undefined`
 * when no skill pack has been authored for that subject (降级链: caller passes
 * no skills option → SDK loads nothing extra → prompt fallback).
 *
 * skillsRoot defaults to <cwd>/src/subjects (the live SoT). Tests inject a
 * fixture root so the resolver works without touching the real on-disk tree.
 */
export function resolveNoteSkill(
  subjectId: string,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): string[] | undefined {
  const skillFile = join(skillsRoot, subjectId, 'skills', NOTE_SKILL_DIR, 'SKILL.md');
  if (!existsSync(skillFile)) return undefined;
  return [NOTE_SKILL_DIR];
}
