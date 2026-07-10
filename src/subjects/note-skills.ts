// YUK-228 (S3 Slice B) — subject → Note Agent Skill name resolution + 降级链.
//
// docs/superpowers/plans/2026-06-06-yuk227-s3-image-reachability.md §1.3 / §2 Slice B
//
// Note skill 键 = subject 级（不带 kind/artifact_type）。三个 Note task
// （NoteGenerateTask / NoteVerifyTask / NoteRefineTask）共用同一份规范包，
// 住在 src/subjects/<id>/skills/note-<id>/SKILL.md。runner 在进程启动时一次性
// mirror src/subjects/<id>/skills/* 到隔离 CLAUDE_CONFIG_DIR/skills（含
// note-<id>/ 目录）；handler 传 ctx.skills = resolveNoteSkill(subjectId) 来
// 白名单激活这一个 skill。
//
// 目录名带 subject 后缀（note-yuwen / note-math / note-physics）是历史命名惯例；
// YUK-611 起扁平镜像统一按 <subjectId>--<pack> 命名空间化（populate-skills.ts），
// 跨科同名不再互踩，白名单键 = 命名空间名（本 resolver 经 skill-namespace.ts 拼名，
// 与镜像键同源）。后缀保留不动——静态 audit（skill-namespace.test.ts）另挡裸名撞车。
//
// 降级链：缺 note-<id> skill 目录 → 返回 undefined → handler 不传 skills 选项
// → runner 走 skills ?? [] 显式禁用 → 现状 prompt 散文回退，never throws。
//
// S2 第二教训（缝隙防御）：本 resolver 只认精确目录名 'note-<subjectId>'；
// resolveQuizGenSkillsForSubject 用 startsWith('quiz-gen-') 过滤，两者不冲突。
// 测试矩阵要求双向断言：resolveNoteSkill 不返回 quiz-gen-*，
// resolveQuizGenSkillsForSubject 不返回 note-*。

import { access } from 'node:fs/promises';
import { join } from 'node:path';
// YUK-611 — 白名单名从命名空间权威模块拼（与 populate 镜像键同源）。
import { namespacedSkillName } from './skill-namespace';

/**
 * Resolve the Note Agent Skill whitelist for a subject. Returns `['note-<subjectId>']`
 * when `src/subjects/<subjectId>/skills/note-<subjectId>/SKILL.md` exists on disk,
 * or `undefined` when no skill pack has been authored for that subject (降级链: caller
 * passes no skills option → SDK loads nothing extra → prompt fallback).
 *
 * skillsRoot defaults to <cwd>/src/subjects (the live SoT). Tests inject a
 * fixture root so the resolver works without touching the real on-disk tree.
 */
export async function resolveNoteSkill(
  subjectId: string,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<string[] | undefined> {
  const noteSkillDir = `note-${subjectId}`;
  const skillFile = join(skillsRoot, subjectId, 'skills', noteSkillDir, 'SKILL.md');
  try {
    await access(skillFile);
  } catch {
    return undefined;
  }
  // 白名单键 = 镜像里的命名空间名 <subjectId>--note-<subjectId>（YUK-611）。
  return [namespacedSkillName(subjectId, noteSkillDir)];
}
