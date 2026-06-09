// YUK-284 (C2) — Copilot 对话方法论 Agent Skill 解析 + 降级链.
// YUK-304 (lane B) — 扩展为双包探测：copilot（对话方法论）+ quiz-gen（出题/组卷
// 方法论，ADR-0031 quiz C→A）。
//
// Copilot 方法论是 cross-subject（mutation-vs-edge / suggestion_kind / proposal_feedback
// 解读等都与学科无关），所以单份共享包住 src/subjects/_shared/skills/copilot/SKILL.md
// （_shared 是非学科伪目录；runner.populateIsolatedSkills 对 src/subjects/ 下每个目录
// 找 skills/ 子目录镜像，不校验是否注册过 SubjectProfile，故零新基建即被镜像）。
// quiz-gen 方法论同理 cross-subject（查重→逐题起草→组卷→诚实降级的编排纪律与学科
// 无关；学科侧的题型规范包另有 quiz-gen-<kind> 命名空间，互不冲突）。
//
// 签名无 subjectId 参数（区别于 resolveNoteSkill(subjectId)）= 体现「这是共享包」。
// 降级链：缺哪个包就不返回哪个名字；全缺 → undefined → caller 不传 skills →
// runner skills ?? [] 显式禁用 → registry.ts 散文兜底回退，never throws。
// 缺包时与现状零差异（这是 C2 风险可控的关键）。
//
// 命名空间：runner 把所有科目 skills/* 扁平 mirror 进同一个 CLAUDE_CONFIG_DIR/skills/，
// collision 风险只在同名时。'copilot' 与 'quiz-gen' 全仓唯一（quiz-gen-skills.ts 的
// per-题型目录是 quiz-gen-translation / quiz-gen-calculation 等带后缀名，且其 resolver
// 按 `quiz-gen-<key>` 精确拼名查找，绝不会捞到裸 'quiz-gen'）。
//
// 见 docs/superpowers/plans/2026-06-08-yuk284-debt-wave.md §2 OPEN-Q1 (单份共享裁决).

import { access } from 'node:fs/promises';
import { join } from 'node:path';

// _shared 是落位约定（非注册 subject — SubjectRegistry 是 profile.ts 的显式 import
// 列表，与目录扫描解耦）。下划线前缀明示「非学科」。
export const COPILOT_SHARED_SUBJECT_DIR = '_shared';
export const COPILOT_SKILL_NAME = 'copilot';
// ADR-0031 / YUK-304 (lane B) — 出题/组卷方法论包。
export const COPILOT_QUIZ_GEN_SKILL_NAME = 'quiz-gen';

// Probe order = whitelist order: the dialogue pack first (general methodology),
// then the quiz-gen pack (task-specific methodology).
const COPILOT_SHARED_SKILL_NAMES = [COPILOT_SKILL_NAME, COPILOT_QUIZ_GEN_SKILL_NAME] as const;

/**
 * Resolve the Copilot shared Agent Skill whitelist (cross-subject). Probes BOTH
 * `_shared/skills/copilot/SKILL.md` and `_shared/skills/quiz-gen/SKILL.md` and
 * returns the found subset (`['copilot','quiz-gen']` / `['copilot']` /
 * `['quiz-gen']`), or `undefined` when neither pack exists (降级链: caller
 * passes no skills option → SDK loads nothing extra → registry.ts systemPrompt
 * 散文 fallback, never throws).
 *
 * No subjectId param: both packs are cross-subject SHARED packs (contrast
 * resolveNoteSkill(subjectId) / resolveQuizGenSkillsForSubject, per-subject).
 *
 * skillsRoot defaults to <cwd>/src/subjects (the live SoT). Tests inject a fixture
 * root so the resolver works without touching the real on-disk tree.
 */
export async function resolveCopilotSkills(
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<string[] | undefined> {
  const found: string[] = [];
  for (const name of COPILOT_SHARED_SKILL_NAMES) {
    const skillFile = join(skillsRoot, COPILOT_SHARED_SUBJECT_DIR, 'skills', name, 'SKILL.md');
    try {
      await access(skillFile);
      found.push(name);
    } catch {
      // pack absent — skip (per-pack 降级, never throws).
    }
  }
  return found.length > 0 ? found : undefined;
}
