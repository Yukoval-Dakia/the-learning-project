// YUK-284 (C2) — Copilot 对话方法论 Agent Skill 解析 + 降级链.
// YUK-304 (lane B) — 扩展为双包探测：copilot（对话方法论）+ quiz-gen（出题/组卷
// 方法论，ADR-0031 quiz C→A）。
//
// Copilot 方法论是 cross-subject（mutation-vs-edge / suggestion_kind / proposal_feedback
// 解读等都与学科无关），所以单份共享包住 src/subjects/_shared/skills/copilot/SKILL.md
// （_shared 是非学科伪目录——不注册 SubjectProfile，仅作共享 skill 落位约定）。
// quiz-gen 方法论同理 cross-subject（查重→逐题起草→组卷→诚实降级的编排纪律与学科
// 无关；学科侧的题型规范包另有 quiz-gen-<kind> 命名空间，互不冲突）。
//
// 签名无 subjectId 参数（区别于 resolveNoteSkillDoc(subjectId)）= 体现「这是共享包」。
// 降级链：缺哪个包就不返回哪个名字；全缺 → undefined → caller 不传 piSkillDocs →
// registry.ts 散文兜底回退，never throws。
// 缺包时与现状零差异（这是 C2 风险可控的关键）。
//
// 命名空间（YUK-611）：包名统一按 <subjectDir>--<pack> 前缀化（skill-namespace.ts），
// 本 resolver 输出 '_shared--copilot' / '_shared--quiz-gen'；跨科/跨包 collision
// 通道已结构性关闭，另有静态 audit（skill-namespace.test.ts）在构建期挡裸名撞车与
// frontmatter 漂移。
//
// 见 docs/superpowers/plans/2026-06-08-yuk284-debt-wave.md §2 OPEN-Q1 (单份共享裁决).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { namespacedSkillName } from './skill-namespace';

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
 * Resolve the Copilot shared Agent Skill docs (cross-subject). Probes BOTH
 * `_shared/skills/copilot/SKILL.md` and `_shared/skills/quiz-gen/SKILL.md` and
 * returns `{name, body}` for the found subset, or `undefined` when neither pack
 * exists (降级链: caller passes no piSkillDocs → registry.ts systemPrompt 散文
 * fallback, never throws). The pi adapter injects the bodies into the system
 * prompt — pi has no filesystem skill loader.
 *
 * No subjectId param: both packs are cross-subject SHARED packs (contrast
 * resolveNoteSkillDoc(subjectId) / resolveQuizGenSkillDocsForSubject,
 * per-subject). Keys are the namespaced names (`_shared--copilot` /
 * `_shared--quiz-gen`) — the pi startup guard matches them 1:1.
 *
 * skillsRoot defaults to <cwd>/src/subjects (the live SoT). Tests inject a fixture
 * root so the resolver works without touching the real on-disk tree.
 */
export async function resolveCopilotSkillDocs(
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<{ name: string; body: string }[] | undefined> {
  const found: { name: string; body: string }[] = [];
  for (const name of COPILOT_SHARED_SKILL_NAMES) {
    const skillFile = join(skillsRoot, COPILOT_SHARED_SUBJECT_DIR, 'skills', name, 'SKILL.md');
    try {
      const body = await readFile(skillFile, 'utf8');
      if (body.length === 0) continue;
      found.push({ name: namespacedSkillName(COPILOT_SHARED_SUBJECT_DIR, name), body });
    } catch {
      // pack absent — skip (per-pack 降级, never throws).
    }
  }
  return found.length > 0 ? found : undefined;
}
