// YUK-284 (C2) — Copilot 对话方法论 Agent Skill 解析 + 降级链.
//
// Copilot 方法论是 cross-subject（mutation-vs-edge / suggestion_kind / proposal_feedback
// 解读等都与学科无关），所以单份共享包住 src/subjects/_shared/skills/copilot/SKILL.md
// （_shared 是非学科伪目录；runner.populateIsolatedSkills 对 src/subjects/ 下每个目录
// 找 skills/ 子目录镜像，不校验是否注册过 SubjectProfile，故零新基建即被镜像）。
//
// 签名无 subjectId 参数（区别于 resolveNoteSkill(subjectId)）= 体现「这是共享包」。
// 降级链：缺 _shared/skills/copilot/SKILL.md → 返回 undefined → caller 不传 skills →
// runner skills ?? [] 显式禁用 → registry.ts 散文兜底回退，never throws。
// 缺包时与现状零差异（这是 C2 风险可控的关键）。
//
// 命名空间：runner 把所有科目 skills/* 扁平 mirror 进同一个 CLAUDE_CONFIG_DIR/skills/，
// collision 风险只在同名时。'copilot' 全仓唯一（不与 note-* / quiz-gen-* 命名空间冲突）。
//
// 见 docs/superpowers/plans/2026-06-08-yuk284-debt-wave.md §2 OPEN-Q1 (单份共享裁决).

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// _shared 是落位约定（非注册 subject — SubjectRegistry 是 profile.ts 的显式 import
// 列表，与目录扫描解耦）。下划线前缀明示「非学科」。
export const COPILOT_SHARED_SUBJECT_DIR = '_shared';
export const COPILOT_SKILL_NAME = 'copilot';

/**
 * Resolve the Copilot dialogue-methodology Agent Skill whitelist (cross-subject).
 * Returns `['copilot']` when `_shared/skills/copilot/SKILL.md` exists on disk, or
 * `undefined` when the pack is absent (降级链: caller passes no skills option → SDK
 * loads nothing extra → registry.ts systemPrompt 散文 fallback, never throws).
 *
 * No subjectId param: the methodology is cross-subject, so this is a SHARED pack
 * (contrast resolveNoteSkill(subjectId), which is per-subject).
 *
 * skillsRoot defaults to <cwd>/src/subjects (the live SoT). Tests inject a fixture
 * root so the resolver works without touching the real on-disk tree.
 */
export function resolveCopilotSkills(
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): string[] | undefined {
  const skillFile = join(
    skillsRoot,
    COPILOT_SHARED_SUBJECT_DIR,
    'skills',
    COPILOT_SKILL_NAME,
    'SKILL.md',
  );
  if (!existsSync(skillFile)) return undefined;
  return [COPILOT_SKILL_NAME];
}
