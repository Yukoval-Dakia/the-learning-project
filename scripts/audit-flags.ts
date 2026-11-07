/**
 * audit:flags — flag 定义、reader 与 base/head 契约门（CLI：报告与退出码）。
 *
 * 唯一登记处是 `src/core/config/registry.ts` 的 CONFIG_REGISTRY（boolean env 开关 +
 * operator 可枚举/CSV/JSON 控制项）；11 个编译期 const 由领域源码自己的
 * `const NAME = true|false` 定义登记。没有第二份台账：本审计从定义和源码推导，
 * 再与 comparison base 的同一份推导逐项对比。
 *
 * 拦什么：
 *   - 源码里出现 `*_ENABLED` 但既没有 CONFIG_REGISTRY 定义，也不是 boolean const；
 *   - 定义声明的 env 名/字面量域/大小写/极性/envMode 与真实 envParse 或 base 不一致；
 *   - 已登记 flag 没有活 reader（或只有直接 process.env 读）；
 *   - base 不可得（fail closed）；
 *   - 非 ENABLED 控制项（enum/CSV/JSON）从定义推导 census，新增控制项不登记即失败。
 *
 * 只报告不改行为：base/head 的 codeDefault、新增/删除键与 reader 集合变化全部打印，
 * 由 review 判断；LITERAL-VARIANCE 仍是 observability only。
 *
 * 扫描去掉注释、保留字符串（很多 flag 经常量名读取）；测试文件不参与。
 * 扫描/git 读取在 ./lib/config-audit/source-scan，纯指纹/对比在
 * ./lib/config-audit/contract-compare。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_REGISTRY, type ConfigKeyDef } from '../src/core/config/registry';
import {
  type ConstDefinition,
  type DefinitionFingerprint,
  type DiffEntry,
  type FlagAuditResult,
  type FlagViolation,
  type ViolationCode,
  compareWithBase,
  computeVariance,
  controlProblems,
  crossCheckHead,
  extractRegistryFingerprints,
  grammarProblems,
  isFamilyKind,
  metadataProblems,
  schemaKindOf,
} from './lib/config-audit/contract-compare';
import {
  REGISTRY_PATH,
  REPO_ROOT,
  SourceTree,
  collectConstFlags,
  collectDirectEnvReads,
  collectReaders,
  headDefinitions,
  isAllowedDirectEnvFile,
  scanFlagTokens,
} from './lib/config-audit/source-scan';
import { resolveAuditBaseSha } from './lib/git-base-scan';

export function auditFlags(comparisonBase?: string): FlagAuditResult {
  const headTree = SourceTree.head();
  const readers = collectReaders(headTree);
  const definitions = headDefinitions(headTree, readers);
  const consts = collectConstFlags(headTree);
  const foundTokens = [...scanFlagTokens(headTree)].sort();

  const violations: FlagViolation[] = [];
  const registered = new Map(definitions.map((def) => [def.key, def]));
  const constByName = new Map<string, ConstDefinition[]>();
  for (const entry of consts) {
    const list = constByName.get(entry.name) ?? [];
    list.push(entry);
    constByName.set(entry.name, list);
  }

  // 1) Every live *_ENABLED token must be a registry flag or a boolean const.
  for (const token of foundTokens) {
    if (registered.has(token)) continue;
    if (constByName.has(token)) continue;
    violations.push({
      code: 'UNREGISTERED',
      name: token,
      detail:
        'live *_ENABLED token with no CONFIG_REGISTRY definition and no `const NAME = true|false`; register the definition (or delete the dead reference)',
    });
  }

  // 2) Constants are single, boolean, and never shadow a registry key.
  for (const [name, entries] of constByName) {
    if (entries.length > 1) {
      violations.push({
        code: 'CONST-PROBLEM',
        name,
        detail: `boolean const declared ${entries.length} times: ${entries.map((entry) => entry.file).join(', ')}`,
      });
    }
    if (registered.has(name)) {
      violations.push({
        code: 'CONST-PROBLEM',
        name,
        detail: 'compile-time const shadows a CONFIG_REGISTRY key (two definitions for one flag)',
      });
    }
  }

  // 3) Every registry definition is complete, parser-accurate, and has a live central reader.
  for (const [key, def] of Object.entries(CONFIG_REGISTRY) as [string, ConfigKeyDef][]) {
    const kind = schemaKindOf(def.schema);
    if (!isFamilyKind(kind, def.envName !== undefined)) continue;
    for (const problem of metadataProblems(def, key)) {
      violations.push({ code: 'DEFINITION-PROBLEM', name: key, detail: problem });
    }
    if (kind === 'flag') {
      for (const problem of grammarProblems(def, key)) {
        violations.push({ code: 'DEFINITION-PROBLEM', name: key, detail: problem });
      }
    } else {
      for (const problem of controlProblems(def, key, kind)) {
        violations.push({ code: 'DEFINITION-PROBLEM', name: key, detail: problem });
      }
    }
    if ((readers.get(key) ?? []).length === 0) {
      violations.push({
        code: 'NO-READER',
        name: key,
        detail: 'no live getConfig/getConfigFlag/getConfigMany call resolves this key',
      });
    }
  }

  // 4) Base/head contract diff, orphaned consumers, and direct-env bypass detection.
  const baseSha = resolveAuditBaseSha(REPO_ROOT, comparisonBase);
  const baseTree = SourceTree.atRef(baseSha);
  const baseRegistryText = baseTree.text(REGISTRY_PATH);
  const headRegistryText = headTree.text(REGISTRY_PATH);
  const diff: DiffEntry[] = [];
  if (baseRegistryText === undefined) {
    violations.push({
      code: 'BASE-PROBLEM',
      name: REGISTRY_PATH,
      detail: `registry file missing at comparison base ${baseSha}`,
    });
    return {
      ok: false,
      base: baseSha,
      definitions,
      consts,
      foundTokens,
      violations,
      diff,
      variance: computeVariance(definitions),
    };
  }

  const headExtraction = headRegistryText
    ? extractRegistryFingerprints(headRegistryText)
    : { fingerprints: new Map<string, DefinitionFingerprint>(), problems: ['registry missing'] };
  for (const problem of headExtraction.problems) {
    violations.push({ code: 'DEFINITION-PROBLEM', name: REGISTRY_PATH, detail: problem });
  }
  violations.push(...crossCheckHead(definitions, headExtraction));

  const baseExtraction = extractRegistryFingerprints(baseRegistryText);
  for (const problem of baseExtraction.problems) {
    violations.push({ code: 'BASE-PROBLEM', name: REGISTRY_PATH, detail: problem });
  }
  if (baseExtraction.fingerprints.size === 0) {
    violations.push({
      code: 'BASE-PROBLEM',
      name: REGISTRY_PATH,
      detail: `could not extract CONFIG_REGISTRY at comparison base ${baseSha}`,
    });
    return {
      ok: false,
      base: baseSha,
      definitions,
      consts,
      foundTokens,
      violations,
      diff,
      variance: computeVariance(definitions),
    };
  }

  const baseReaders = collectReaders(baseTree);
  const compared = compareWithBase(
    baseExtraction.fingerprints,
    headExtraction.fingerprints,
    new Map(definitions.map((def) => [def.key, def])),
    baseReaders,
    collectConstFlags(baseTree),
    consts,
  );
  violations.push(...compared.violations);
  diff.push(...compared.diff);

  const headReads = collectDirectEnvReads(headTree);
  const baseReadIds = new Set(
    collectDirectEnvReads(baseTree).map((read) => `${read.key}\u0000${read.file}`),
  );

  // (a) A definition removed at head must not leave direct env reads behind.
  for (const key of baseExtraction.fingerprints.keys()) {
    if (registered.has(key)) continue;
    const orphanReads = headReads.filter((read) => read.key === key);
    if (orphanReads.length > 0) {
      const files = [...new Set(orphanReads.map((read) => read.file))].sort();
      violations.push({
        code: 'ORPHAN-ENV-READ',
        name: key,
        detail: `definition removed at head but still read directly from ${files.join(', ')}`,
      });
    }
    const headFiles = readers.get(key) ?? [];
    if (headFiles.length > 0) {
      violations.push({
        code: 'ORPHAN-READER',
        name: key,
        detail: `definition removed at head but still read from ${headFiles.join(', ')}`,
      });
    }
  }

  // (b) A registered key read directly from process.env bypasses DB/env/default resolution.
  //     Only new (key, file) pairs relative to base fail; existing reads are grandfathered.
  for (const read of headReads) {
    if (!registered.has(read.key)) continue;
    if (isAllowedDirectEnvFile(read.file)) continue;
    if (baseReadIds.has(`${read.key}\u0000${read.file}`)) continue;
    violations.push({
      code: 'DIRECT-ENV-READ',
      name: read.key,
      detail: `registered key read directly from process.env in ${read.file} (${read.form}); use getConfig/getConfigFlag/getConfigMany`,
    });
  }

  return {
    ok: violations.length === 0,
    base: baseSha,
    definitions,
    consts,
    foundTokens,
    violations,
    diff,
    variance: computeVariance(definitions),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

function baseFlag(): string | undefined {
  const index = process.argv.indexOf('--base');
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value) throw new Error('--base requires a commit SHA.');
  return value;
}

function printViolations(violations: FlagViolation[]): void {
  const groups = new Map<ViolationCode, FlagViolation[]>();
  for (const violation of violations) {
    const list = groups.get(violation.code) ?? [];
    list.push(violation);
    groups.set(violation.code, list);
  }
  for (const code of [
    'UNREGISTERED',
    'DEFINITION-PROBLEM',
    'NO-READER',
    'ORPHAN-READER',
    'ORPHAN-ENV-READ',
    'DIRECT-ENV-READ',
    'CONST-PROBLEM',
    'BASE-PROBLEM',
    'BASE-DRIFT',
  ] satisfies ViolationCode[]) {
    const list = groups.get(code);
    if (!list || list.length === 0) continue;
    console.log(`  ${code}: ${list.length}`);
    for (const violation of list) console.log(`    - ${violation.name}: ${violation.detail}`);
    console.log('');
  }
}

function main(): void {
  const isJson = process.argv.includes('--json');
  const isStrict = process.argv.includes('--strict');

  const requested = baseFlag() ?? process.env.CAPABILITY_BASE_SHA;
  const base = process.env.TEST_POLICY_BASE || resolveAuditBaseSha(REPO_ROOT, requested);
  const result = auditFlags(base);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const flags = result.definitions.filter((def) => def.kind === 'flag').length;
    const controls = result.definitions.length - flags;
    console.log('audit:flags — flag 定义、reader 与 base/head 契约门\n');
    console.log(
      `  definitions: ${result.definitions.length} family keys (flag×${flags}, control×${controls}); const×${result.consts.length}; live *_ENABLED tokens: ${result.foundTokens.length}.`,
    );
    console.log(`  base: ${result.base ?? '(missing)'}\n`);

    printViolations(result.violations);

    const shippedDiff = result.diff.filter(
      (entry) => entry.field !== 'const-value' && entry.field !== 'codeDefault',
    );
    const defaultDiff = result.diff.filter(
      (entry) => entry.field === 'const-value' || entry.field === 'codeDefault',
    );
    console.log(
      `  BASE/HEAD 定义变化: ${shippedDiff.length === 0 ? '(none)' : shippedDiff.length}`,
    );
    for (const entry of shippedDiff) {
      console.log(
        `    - ${entry.name} ${entry.field}: ${JSON.stringify(entry.base)} → ${JSON.stringify(entry.head)}`,
      );
    }
    if (defaultDiff.length > 0) {
      console.log(`  BASE/HEAD 默认值变化（informational，review 负责）: ${defaultDiff.length}`);
      for (const entry of defaultDiff) {
        console.log(
          `    - ${entry.name} ${entry.field}: ${JSON.stringify(entry.base)} → ${JSON.stringify(entry.head)}`,
        );
      }
    }
    console.log('');

    console.log(
      `  LITERAL-VARIANCE — env flag 字面量约定（report-only, ${result.variance.length} 种）:`,
    );
    for (const group of result.variance) {
      console.log(`    · ${group.signature}`);
      for (const key of group.flags) console.log(`        ${key}`);
    }
    console.log('');
    console.log(
      '  定义在 src/core/config/registry.ts；const 由领域源码自己的 boolean 声明登记。' +
        ' 直接 env 读只对已登记 key 与 base 删除的 key 检查，不做全仓未登记 env 普查。' +
        ' report-only (exit 0); --strict gates UNREGISTERED / DEFINITION-PROBLEM / NO-READER / ORPHAN-* / DIRECT-ENV-READ / CONST-PROBLEM / BASE-DRIFT.',
    );
  }

  if (!result.ok) {
    const baseBroken = result.violations.some((violation) => violation.code === 'BASE-PROBLEM');
    // An unmeasurable base fails closed in every mode; other findings need --strict.
    if (isStrict || baseBroken) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[audit:flags] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
