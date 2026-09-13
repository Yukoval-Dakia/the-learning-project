// pnpm gen:prompt-hashes — prompt-hash oracle 再生成器。
//
// src/ai/registry.test.ts 的 oracle 测试把每个 task × subject profile 的系统 prompt
// 钉在 src/ai/fixtures/task-prompt-hashes.6b3233b1.json（YUK-949 注册表重构的
// 迁移同一性守卫）。**有意**改 prompt（task spec 编辑）后必须重生本 fixture 并与
// 改动同 commit（记忆 #646）；在此之前没有固化脚本，两次靠手写一次性文件重生。
//
// 用法：pnpm gen:prompt-hashes（就地重写 fixture，保留 baseCommit/algorithm/profiles）。
// 注意：fixture 文件名里的 6b3233b1 是迁移基线 commit 标识，不是当前 hash——不改名。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveSubjectProfile } from '@/subjects/profile';
import { tasks } from '../src/ai/registry';
import { getTaskSystemPrompt } from '../src/ai/task-prompts';

const FIXTURE_PATH = 'src/ai/fixtures/task-prompt-hashes.6b3233b1.json';

const oracle = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  baseCommit: string;
  algorithm: string;
  taskCount: number;
  profiles: string[];
  prompts: Record<string, string>;
};

const prompts: Record<string, string> = {};
for (const profileId of oracle.profiles) {
  const profile = resolveSubjectProfile(profileId);
  for (const task of Object.keys(tasks)) {
    prompts[`${profileId}:${task}`] = createHash('sha256')
      .update(getTaskSystemPrompt(task as keyof typeof tasks, profile), 'utf8')
      .digest('hex');
  }
}

oracle.taskCount = Object.keys(tasks).length;
oracle.prompts = prompts;
writeFileSync(FIXTURE_PATH, `${JSON.stringify(oracle, null, 2)}\n`);
// biome 的 JSON formatter 与 JSON.stringify 的短数组风格不同（profiles 会被展开）——
// 写后跑一遍 formatter，保证幂等重生零 diff（不过 lint 格式闸）。
execFileSync('./node_modules/.bin/biome', ['format', '--write', FIXTURE_PATH], {
  stdio: 'inherit',
});

console.log(
  `[gen:prompt-hashes] regenerated ${FIXTURE_PATH}: ${Object.keys(prompts).length} entries, ${oracle.taskCount} tasks`,
);
