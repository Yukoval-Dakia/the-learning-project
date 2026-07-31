import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PRE_PR_COMMANDS = [
  'pnpm typecheck',
  'pnpm lint',
  'pnpm audit:schema',
  'pnpm audit:partition',
  'pnpm audit:profile',
  'pnpm audit:draft-status',
  'pnpm audit:draft-status-reads',
  'pnpm test',
  'pnpm build',
];

const STALE_TOKENS = ['claude-context', '/oh-my-Codex:', 'Codex + Gemini + Codex'];

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');

const walkSkillFiles = (root: string, path: string): string[] => {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...walkSkillFiles(root, child));
    if (entry.isFile() && entry.name === 'SKILL.md') files.push(child);
  }
  return files;
};

const hasSkillFrontmatter = (content: string): boolean => {
  if (!content.startsWith('---\n')) return false;
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return false;
  const frontmatter = content.slice(4, end);
  return /^name:\s*\S+/m.test(frontmatter) && /^description:\s*.+/m.test(frontmatter);
};

const collectCommands = (value: unknown, commands: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const child of value) collectCommands(child, commands);
    return commands;
  }
  if (!value || typeof value !== 'object') return commands;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'command' && typeof child === 'string') commands.push(child);
    collectCommands(child, commands);
  }
  return commands;
};

export function auditAgentControlPlane(root: string): string[] {
  const errors: string[] = [];

  const agents = read(root, 'AGENTS.md');
  if (agents.trimEnd().split('\n').length > 200) {
    errors.push('AGENTS.md exceeds the 200-line control-plane budget');
  }

  if (read(root, 'CLAUDE.md').trim() !== '@AGENTS.md') {
    errors.push('CLAUDE.md must contain only @AGENTS.md');
  }
  if (existsSync(join(root, '.claude/CLAUDE.md'))) {
    errors.push('.claude/CLAUDE.md duplicates the root instruction layer');
  }
  if (existsSync(join(root, '.agents/skills/omc-reference/SKILL.md'))) {
    errors.push('Claude-specific omc-reference must not be mirrored into Codex skills');
  }

  if (read(root, '.agents/skills/pr/SKILL.md') !== read(root, '.claude/skills/pr/SKILL.md')) {
    errors.push('PR skill adapters have drifted between Codex and Claude');
  }

  const workflow = read(root, 'docs/agents/development-workflow.md');
  const prePr = workflow.match(/Before a PR, run:\s*```bash\n([\s\S]*?)```/)?.[1] ?? '';
  for (const command of REQUIRED_PRE_PR_COMMANDS) {
    if (!prePr.includes(command)) errors.push(`Pre-PR gate is missing: ${command}`);
  }

  const controlFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    'docs/agents/development-workflow.md',
    '.claude/hooks/code-search-preload.sh',
    ...walkSkillFiles(root, '.claude/skills'),
    ...walkSkillFiles(root, '.agents/skills'),
  ];
  for (const path of controlFiles) {
    const content = read(root, path);
    for (const token of STALE_TOKENS) {
      if (content.includes(token)) errors.push(`${path} contains stale token: ${token}`);
    }
  }

  for (const path of [
    ...walkSkillFiles(root, '.claude/skills'),
    ...walkSkillFiles(root, '.agents/skills'),
  ]) {
    if (!hasSkillFrontmatter(read(root, path))) {
      errors.push(`${path} is missing name/description frontmatter`);
    }
  }

  for (const path of ['.claude/settings.json', '.codex/hooks.json']) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(read(root, path));
    } catch (error) {
      errors.push(`${path} is invalid JSON: ${(error as Error).message}`);
      continue;
    }
    for (const command of collectCommands(parsed)) {
      if (/(?:node|bash)\s+\.claude\//.test(command)) {
        errors.push(`${path} uses a cwd-sensitive hook command: ${command}`);
      }
    }
  }

  const claudeHooks = read(root, '.claude/settings.json');
  const codexHooks = read(root, '.codex/hooks.json');
  for (const [path, content] of [
    ['.claude/settings.json', claudeHooks],
    ['.codex/hooks.json', codexHooks],
  ] as const) {
    if (!content.includes('linear-closeout-reminder.sh')) {
      errors.push(`${path} is missing the shared Linear closeout hook`);
    }
  }

  return errors;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const root = resolve(dirname(currentFile), '..');
  const errors = auditAgentControlPlane(root);
  if (errors.length) {
    console.error(`Agent control-plane audit failed (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log('Agent control-plane audit passed.');
  }
}
