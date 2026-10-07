import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Skill-mirror contract between `.agents/skills/` and `.claude/skills/`.
 *
 * Both trees are live agent surfaces (Codex-side vs Claude Code-side) for the
 * same skills; nothing else guards them against silent drift — PR #1565 had to
 * hand-fix one copy of launch-phase after main had already fixed the other.
 *
 * Contract (over TRACKED files only, so untracked local WIP cannot
 * false-positive; CI checkouts and local clones see the same set):
 * - MIRRORED_SKILLS must exist in both trees with identical tracked file sets,
 *   and every file byte-identical across the trees. Harness-specific guidance
 *   lives INSIDE the shared file (see "Harness 适配" in launch-phase), not in
 *   divergent copies.
 * - ONE_SIDED_SKILLS registers skills that intentionally live in one tree only.
 *   Any tracked skill directory outside both lists fails the audit with fix
 *   guidance.
 *
 * The `pr` byte-equality check used to live in audit-agent-control-plane.ts;
 * it moved here so each rule has one home.
 */

const AGENTS_TREE = '.agents/skills';
const CLAUDE_TREE = '.claude/skills';

const MIRRORED_SKILLS = ['audit-drift', 'launch-phase', 'pr'] as const;

const ONE_SIDED_SKILLS: Record<'agents' | 'claude', readonly string[]> = {
  agents: [],
  claude: ['audits-reference', 'omc-reference', 'postman-api'],
};

const listTrackedFiles = (root: string, tree: string): string[] => {
  const out = execFileSync('git', ['ls-files', '--', tree], {
    cwd: root,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const skillDirOf = (trackedPath: string, tree: string): string | null => {
  const prefix = `${tree}/`;
  if (!trackedPath.startsWith(prefix)) return null;
  const rest = trackedPath.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null; // files directly under the tree root are not a skill dir
  return rest.slice(0, slash);
};

export function auditSkillMirrors(root: string): string[] {
  const errors: string[] = [];

  if (!existsSync(join(root, '.git'))) {
    errors.push('audit-skill-mirrors must run inside a git checkout (tracked-file contract)');
    return errors;
  }

  const agentsFiles = listTrackedFiles(root, AGENTS_TREE);
  const claudeFiles = listTrackedFiles(root, CLAUDE_TREE);

  const agentsSkills = new Set(
    agentsFiles.map((f) => skillDirOf(f, AGENTS_TREE)).filter((s): s is string => s !== null),
  );
  const claudeSkills = new Set(
    claudeFiles.map((f) => skillDirOf(f, CLAUDE_TREE)).filter((s): s is string => s !== null),
  );

  // 1. Mirrored pairs: identical tracked file sets + byte-identical contents.
  for (const skill of MIRRORED_SKILLS) {
    const agentsSkillFiles = agentsFiles.filter((f) => skillDirOf(f, AGENTS_TREE) === skill);
    const claudeSkillFiles = claudeFiles.filter((f) => skillDirOf(f, CLAUDE_TREE) === skill);

    if (agentsSkillFiles.length === 0 || claudeSkillFiles.length === 0) {
      errors.push(
        `mirrored skill '${skill}' is missing from ${agentsSkillFiles.length === 0 ? AGENTS_TREE : CLAUDE_TREE}`,
      );
      continue;
    }

    const agentsRel = new Set(agentsSkillFiles.map((f) => f.slice(`${AGENTS_TREE}/`.length)));
    const claudeRel = new Set(claudeSkillFiles.map((f) => f.slice(`${CLAUDE_TREE}/`.length)));
    for (const rel of agentsRel) {
      if (!claudeRel.has(rel))
        errors.push(`${AGENTS_TREE}/${rel} has no ${CLAUDE_TREE} counterpart`);
    }
    for (const rel of claudeRel) {
      if (!agentsRel.has(rel))
        errors.push(`${CLAUDE_TREE}/${rel} has no ${AGENTS_TREE} counterpart`);
    }

    for (const rel of agentsRel) {
      if (!claudeRel.has(rel)) continue;
      const agentsContent = readFileSync(join(root, AGENTS_TREE, rel));
      const claudeContent = readFileSync(join(root, CLAUDE_TREE, rel));
      if (!agentsContent.equals(claudeContent)) {
        errors.push(
          `mirrored skill '${skill}' has drifted: ${rel} differs between ${AGENTS_TREE} and ${CLAUDE_TREE} — reconcile into one shared body (harness-specific guidance belongs inside the shared file), then copy it to both trees`,
        );
      }
    }
  }

  // 2. Every tracked skill dir must be declared (mirrored or one-sided).
  for (const skill of agentsSkills) {
    if ((MIRRORED_SKILLS as readonly string[]).includes(skill)) continue;
    if (ONE_SIDED_SKILLS.agents.includes(skill)) continue;
    errors.push(
      `undeclared skill '${skill}' in ${AGENTS_TREE}: mirror it into ${CLAUDE_TREE} (byte-identical) or register it in ONE_SIDED_SKILLS.agents in scripts/audit-skill-mirrors.ts`,
    );
  }
  for (const skill of claudeSkills) {
    if ((MIRRORED_SKILLS as readonly string[]).includes(skill)) continue;
    if (ONE_SIDED_SKILLS.claude.includes(skill)) continue;
    errors.push(
      `undeclared skill '${skill}' in ${CLAUDE_TREE}: mirror it into ${AGENTS_TREE} (byte-identical) or register it in ONE_SIDED_SKILLS.claude in scripts/audit-skill-mirrors.ts`,
    );
  }

  // 3. One-sided registrations must still exist (no silent deletion).
  for (const skill of ONE_SIDED_SKILLS.agents) {
    if (!agentsSkills.has(skill))
      errors.push(`registered one-sided skill '${skill}' no longer exists in ${AGENTS_TREE}`);
  }
  for (const skill of ONE_SIDED_SKILLS.claude) {
    if (!claudeSkills.has(skill))
      errors.push(`registered one-sided skill '${skill}' no longer exists in ${CLAUDE_TREE}`);
  }

  return errors;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const root = resolve(dirname(currentFile), '..');
  const errors = auditSkillMirrors(root);
  if (errors.length) {
    console.error(`Skill-mirror audit failed (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log('Skill-mirror audit passed.');
  }
}
