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
 *   - 非 ENABLED 控制项（enum/CSV/JSON）从定义推导 census，新增控制项不登记即失败；
 *   - 产品代码（src/、server/，测试除外）新增命名 process.env 读：不管变量在 registry、
 *     boot schema 还是 stay 清单，只要 base 没有同一 key×file（文件搬家按 rename 继承）且
 *     不在 STAY_IN_PLACE_ENV 的 owner 下，就失败；boot 名读解析好的 env，registry 名走
 *     getConfig，只有 provider/第三方凭据与启动前必读进 stay 清单；
 *   - 新增动态 process.env[...] 读；新增 registry envName 缺 boot schema；
 *   - 非 family 键（number/string、无 env 的 json/enum）新增键缺 metadata/reader 或新增直读。
 *     非 family 与存量 env 读只汇报，按 base 放行。
 *
 * 不在扫描范围（文件头有完整边界）：`const e = process.env` 别名、`globalThis.process`、
 * `Object.keys(process.env)`、computed destructure、把 process.env 传给 helper；
 * `src/core/config/` 的 DIRECT-ENV-READ 豁免不适用于新增读点门。
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
import { SERVER_ENV_KEYS } from '../src/core/config/server/env';
import {
  type ConstDefinition,
  type DefinitionFingerprint,
  type DiffEntry,
  type EnvCensusReport,
  type FlagAuditResult,
  type FlagViolation,
  type NonFamilyReport,
  type StayInPlaceEntry,
  type ViolationCode,
  auditNonFamilyKeys,
  compareWithBase,
  computeEnvCensus,
  computeVariance,
  controlProblems,
  crossCheckHead,
  extractRegistryFingerprints,
  extractRegistryKeyCensus,
  grammarProblems,
  isFamilyKind,
  metadataProblems,
  schemaKindOf,
} from './lib/config-audit/contract-compare';
import {
  BOOT_ENV_PATH,
  REGISTRY_PATH,
  REPO_ROOT,
  SourceTree,
  collectConstFlags,
  collectDirectEnvReads,
  collectProductEnvReads,
  collectReaders,
  extractBootEnvKeys,
  headDefinitions,
  isAllowedDirectEnvFile,
  isAllowedDynamicEnvFile,
  scanFlagTokens,
} from './lib/config-audit/source-scan';
import { resolveAuditBaseSha, worktreeRenameMap } from './lib/git-base-scan';

/**
 * Direct reads that stay outside the registry/boot schema by design, each scoped to its
 * owner (config inventory §2: provider credentials and third-party adapters, boot-time reads,
 * test/deploy knobs). Only the owner may add new reads; any other file must use the parsed
 * env or getConfig, or this list grows with a new owner and reason.
 */
const STAY_IN_PLACE_ENV: readonly StayInPlaceEntry[] = [
  // boot / pre-hydration entries
  {
    env: 'DATABASE_URL',
    owner: 'server/',
    reason: 'API/worker entry builds the pool before the DB-backed config layer exists',
  },
  {
    env: 'INTERNAL_TOKEN',
    owner: 'server/',
    reason: 'API entry validates the shared token before serving',
  },
  { env: 'API_PORT', owner: 'server/', reason: 'listen port is resolved before config hydration' },
  {
    env: 'DEV_HOST',
    owner: 'server/dev-frontdoor.ts',
    reason: 'dev front door binds before config hydration',
  },
  {
    env: 'DB_POOL_MAX',
    owner: 'src/db/pool.ts',
    reason: 'pool size must be known before the DB-backed config layer',
  },
  // provider credentials / third-party adapters
  {
    env: 'DASHSCOPE_API_KEY',
    owner: 'src/server/ai/',
    reason: 'embedding provider credential owned by the embedding adapter',
  },
  {
    env: 'OPENROUTER_API_KEY',
    owner: 'src/server/ai/',
    reason: 'provider credential owned by the AI provider layer',
  },
  {
    env: 'OPENAI_CHATGPT_AUTH_FILE',
    owner: 'src/server/ai/pi-models.ts',
    reason: 'pi auth file owned by the pi model adapter',
  },
  {
    env: 'ZHIPU_API_KEY',
    owner: 'src/capabilities/ingestion/server/',
    reason: 'OCR/vision provider key owned by the ingestion adapters',
  },
  {
    env: 'TENCENT_SECRET_ID',
    owner: 'src/capabilities/ingestion/server/tencent_mark.ts',
    reason: 'Tencent OCR credential owned by the Tencent adapter',
  },
  {
    env: 'TENCENT_SECRET_KEY',
    owner: 'src/capabilities/ingestion/server/tencent_mark.ts',
    reason: 'Tencent OCR credential owned by the Tencent adapter',
  },
  {
    env: 'TENCENT_OCR_REGION',
    owner: 'src/capabilities/ingestion/server/tencent_mark.ts',
    reason: 'Tencent OCR region owned by the Tencent adapter',
  },
  {
    env: 'EXA_API_KEY',
    owner: 'src/ai/exa-mcp.ts',
    reason: 'Exa MCP credential owned by the Exa adapter',
  },
  {
    env: 'R2_ENDPOINT',
    owner: 'src/kernel/object-storage.ts',
    reason: 'blob storage endpoint owned by the S3-compatible client',
  },
  {
    env: 'R2_ACCESS_KEY_ID',
    owner: 'src/kernel/object-storage.ts',
    reason: 'blob storage credential owned by the S3-compatible client',
  },
  {
    env: 'R2_SECRET_ACCESS_KEY',
    owner: 'src/kernel/object-storage.ts',
    reason: 'blob storage credential owned by the S3-compatible client',
  },
  {
    env: 'R2_BUCKET',
    owner: 'src/kernel/object-storage.ts',
    reason: 'blob storage bucket owned by the S3-compatible client',
  },
  {
    env: 'LMNR_PROJECT_API_KEY',
    owner: 'src/server/ai/',
    reason: 'Laminar tracing key owned by the tracing adapter',
  },
  {
    env: 'LMNR_DEBUG',
    owner: 'src/server/ai/',
    reason: 'Laminar tracing SDK option owned by the tracing adapter',
  },
  {
    env: 'LMNR_SPAN_CONTEXT',
    owner: 'src/server/ai/',
    reason: 'Laminar tracing SDK option owned by the tracing adapter',
  },
  {
    env: 'LMNR_TRACE_METADATA',
    owner: 'src/server/ai/',
    reason: 'Laminar tracing SDK option owned by the tracing adapter',
  },
  {
    env: 'LMNR_TRACE_ENV',
    owner: 'src/server/ai/',
    reason: 'Laminar tracing SDK option owned by the tracing adapter',
  },
  {
    env: 'LMNR_TRANSCRIPTS',
    owner: 'src/server/ai/',
    reason: 'Laminar transcript option owned by the tracing adapter',
  },
  {
    env: 'LMNR_DEV_TRANSCRIPTS',
    owner: 'src/server/ai/',
    reason: 'Laminar transcript option owned by the tracing adapter',
  },
  {
    env: 'MEM0_EMBEDDING_BASE_URL',
    owner: 'src/server/ai/',
    reason: 'embedding endpoint owned by the embedding adapter',
  },
  {
    env: 'MEM0_EMBEDDING_BASE_URL',
    owner: 'src/capabilities/practice/question-bank/tools/search-bank.ts',
    reason: 'bank search probes the embedding endpoint before building the query',
  },
  {
    env: 'MEM0_EMBEDDING_MODEL',
    owner: 'src/server/ai/',
    reason: 'embedding model owned by the embedding adapter',
  },
  // internal HMAC / entry secrets
  {
    env: 'JUDGE_PROVENANCE_SECRET',
    owner: 'src/capabilities/practice/grading/server/judge/preview-provenance-token.ts',
    reason: 'HMAC secret read at the signing entry',
  },
  {
    env: 'BANK_GAP_EVIDENCE_SECRET',
    owner: 'src/capabilities/practice/question-bank/tools/bank-search.ts',
    reason: 'HMAC secret read at the evidence entry',
  },
  // test / deploy knobs
  {
    env: 'VITEST',
    owner: 'src/kernel/background-job-enqueue.ts',
    reason: 'test-mode branch in the job enqueue helper',
  },
  {
    env: 'DOCKER_HOST',
    owner: 'src/server/release/rehearsal/ephemeral-pg.ts',
    reason: 'rehearsal-only Docker endpoint',
  },
  {
    env: 'PLAYWRIGHT_BROWSERS_PATH',
    owner: 'src/capabilities/practice/question-bank/server/custom-block-preview/chromium-runner.ts',
    reason: 'deployment browser root for the render runner',
  },
];

export function auditFlags(comparisonBase?: string): FlagAuditResult {
  const headTree = SourceTree.head();
  const readers = collectReaders(headTree);
  const definitions = headDefinitions(headTree, readers);
  const consts = collectConstFlags(headTree);
  const foundTokens = [...scanFlagTokens(headTree)].sort();
  const allEntries = Object.entries(CONFIG_REGISTRY) as [string, ConfigKeyDef][];

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

  // Boot schema: the runtime SERVER_ENV_KEYS set must equal what the AST extractor sees,
  // and the base must be readable or the env census is unmeasurable (fail closed).
  const headBootText = headTree.text(BOOT_ENV_PATH);
  const headBootExtraction = headBootText
    ? extractBootEnvKeys(headBootText)
    : { keys: [], problems: [`${BOOT_ENV_PATH} is missing at head`] };
  for (const problem of headBootExtraction.problems) {
    violations.push({ code: 'DEFINITION-PROBLEM', name: BOOT_ENV_PATH, detail: problem });
  }
  const headBootKeys = new Set(headBootExtraction.keys);
  const headBootMeasurable = headBootText !== undefined && headBootExtraction.problems.length === 0;
  const runtimeBootKeys = new Set(SERVER_ENV_KEYS);
  for (const key of [...runtimeBootKeys].filter((name) => !headBootKeys.has(name)).sort()) {
    violations.push({
      code: 'DEFINITION-PROBLEM',
      name: BOOT_ENV_PATH,
      detail: `runtime SERVER_ENV_KEYS includes ${key} but the AST extractor does not`,
    });
  }
  for (const key of [...headBootKeys].filter((name) => !runtimeBootKeys.has(name)).sort()) {
    violations.push({
      code: 'DEFINITION-PROBLEM',
      name: BOOT_ENV_PATH,
      detail: `AST extractor sees ${key} but runtime SERVER_ENV_KEYS does not`,
    });
  }

  const baseBootText = baseTree.text(BOOT_ENV_PATH);
  let baseBootKeys: Set<string> | null = null;
  if (baseBootText === undefined) {
    violations.push({
      code: 'BASE-PROBLEM',
      name: BOOT_ENV_PATH,
      detail: `missing at comparison base ${baseSha}`,
    });
  } else {
    const baseBootExtraction = extractBootEnvKeys(baseBootText);
    for (const problem of baseBootExtraction.problems) {
      violations.push({ code: 'BASE-PROBLEM', name: BOOT_ENV_PATH, detail: problem });
    }
    if (baseBootExtraction.keys.length === 0) {
      violations.push({
        code: 'BASE-PROBLEM',
        name: BOOT_ENV_PATH,
        detail: `could not extract the boot env schema at comparison base ${baseSha}`,
      });
    } else if (baseBootExtraction.problems.length === 0) {
      baseBootKeys = new Set(baseBootExtraction.keys);
    }
  }

  const baseRegistryCensus = extractRegistryKeyCensus(baseRegistryText);
  for (const problem of baseRegistryCensus.problems) {
    violations.push({ code: 'BASE-PROBLEM', name: REGISTRY_PATH, detail: problem });
  }
  if (baseRegistryCensus.entries.size === 0) {
    violations.push({
      code: 'BASE-PROBLEM',
      name: REGISTRY_PATH,
      detail: `could not extract every CONFIG_REGISTRY key at comparison base ${baseSha}`,
    });
  }

  // Product-code env census: every read must own a table; only new reads/dynamic accesses gate.
  const envNameOf = (def: ConfigKeyDef): string | null => def.envName ?? null;
  const registryEnvs = new Set(
    allEntries.map(([, def]) => envNameOf(def)).filter((name): name is string => name !== null),
  );
  const baseRegistryEnvs = new Set(
    [...baseRegistryCensus.entries.values()]
      .map((entry) => entry.envName)
      .filter((name): name is string => name !== null),
  );
  const baseRegistryMeasurable =
    baseRegistryCensus.problems.length === 0 && baseRegistryCensus.entries.size > 0;
  let envCensus: EnvCensusReport | undefined;
  let nonFamily: NonFamilyReport | undefined;
  if (headBootMeasurable && baseBootKeys && baseRegistryMeasurable) {
    const headProductReads = collectProductEnvReads(headTree);
    const baseProductReads = collectProductEnvReads(baseTree);
    const movedFromBase = new Map<string, string>();
    for (const [baseFile, headFile] of worktreeRenameMap(REPO_ROOT, baseSha, ['src', 'server'])) {
      movedFromBase.set(headFile, baseFile);
    }
    const census = computeEnvCensus({
      registryEnvs,
      baseRegistryEnvs,
      bootKeys: headBootKeys,
      baseBootKeys,
      stayInPlace: STAY_IN_PLACE_ENV,
      headNamedReads: headProductReads.named,
      baseNamedReads: baseProductReads.named,
      headDynamicReads: headProductReads.dynamic,
      baseDynamicReads: baseProductReads.dynamic,
      baseFileOf: (file) => movedFromBase.get(file) ?? file,
      isAllowedDynamicFile: isAllowedDynamicEnvFile,
    });
    envCensus = census.report;
    violations.push(...census.violations);
  }
  if (baseRegistryMeasurable) {
    const familyKeys = new Set(definitions.map((def) => def.key));
    const nonFamilyAudit = auditNonFamilyKeys({
      entries: allEntries
        .filter(([key]) => !familyKeys.has(key))
        .map(([key, def]) => ({
          key,
          envName: envNameOf(def),
          metadataProblems: metadataProblems(def, key),
          readerCount: (readers.get(key) ?? []).length,
        })),
      baseKeys: new Set(baseRegistryCensus.entries.keys()),
      headReads,
      baseReadIds,
      isAllowedDirectEnvFile,
    });
    nonFamily = nonFamilyAudit.report;
    violations.push(...nonFamilyAudit.violations);
  }

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
  //     Match by envName, not key: lane.global.provider is read as AI_PROVIDER_OVERRIDE.
  //     Only new (env name, file) pairs relative to base fail; existing reads are grandfathered.
  //     Non-family keys are handled by auditNonFamilyKeys above.
  const envNameToKeys = new Map<string, string[]>();
  for (const [key, def] of allEntries) {
    if (!def.envName) continue;
    const list = envNameToKeys.get(def.envName) ?? [];
    list.push(key);
    envNameToKeys.set(def.envName, list);
  }
  for (const read of headReads) {
    if (isAllowedDirectEnvFile(read.file)) continue;
    const keys = envNameToKeys.get(read.key) ?? (registered.has(read.key) ? [read.key] : []);
    for (const key of keys) {
      if (!registered.has(key)) continue;
      if (baseReadIds.has(`${read.key}\u0000${read.file}`)) continue;
      violations.push({
        code: 'DIRECT-ENV-READ',
        name: key,
        detail: `registered key '${key}' (env ${read.key}) read directly from process.env in ${read.file} (${read.form}); use getConfig/getConfigFlag/getConfigMany`,
      });
    }
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
    envCensus,
    nonFamily,
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
    'UNCLASSIFIED-ENV-READ',
    'DYNAMIC-ENV-READ',
    'REGISTRY-SCHEMA-GAP',
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

function printEnvCensus(census: EnvCensusReport): void {
  const existingRegistryOnly = new Set(census.existingRegistryOnly);
  console.log('  ENV CENSUS — 产品代码 env 读（src/ + server/，测试排除）');
  console.log(
    `    registry envName ${census.registryEnvCount}；boot schema ${census.bootKeyCount}；交集 ${census.overlapCount}`,
  );
  console.log(
    `    命名读 ${census.namedReadCount} 个 (key×file) / ${census.namedFileCount} 文件 / ${census.namedNameCount} 名；存量放行 ${census.existingNamedReadCount}（含 rename 继承）；动态读 ${census.dynamicReadCount} 处 / ${census.dynamicByFile.length} 文件`,
  );
  console.log(
    `    归属：registry ${census.classified.registry}，boot schema ${census.classified.boot}，stay-in-place ${census.classified.stay}`,
  );

  console.log(`    schema-only（boot 独占，无 registry envName）：${census.schemaOnly.length}`);
  for (const key of census.schemaOnly) console.log(`      ${key}`);

  console.log(
    `    registry-only（registry envName 缺 boot schema）：${census.registryOnly.length}`,
  );
  for (const key of census.registryOnly) {
    console.log(`      ${key}${existingRegistryOnly.has(key) ? ' (existing)' : ''}`);
  }

  if (census.hidden.length > 0) {
    console.log(
      `    hidden（产品代码在读，registry、boot schema 与 stay 清单都没有）：${census.hidden.length}`,
    );
    for (const item of census.hidden) console.log(`      ${item.key} ← ${item.files.join(', ')}`);
  }

  if (census.existingUnclassified.length > 0) {
    console.log(
      `    存量无表读（report-only，base 已存在的同一 key×file）：${census.existingUnclassified.length}`,
    );
    for (const item of census.existingUnclassified) {
      console.log(`      ${item.key} @ ${item.file}`);
    }
  }

  if (census.dynamicByFile.length > 0) {
    console.log('    动态 env 读（report-only，现有；只有新增会红）：');
    for (const item of census.dynamicByFile) {
      console.log(`      ${item.file} × ${item.count}`);
    }
  }

  if (census.stayInPlace.length > 0) {
    console.log(`    stay-in-place（只对 owner 放行的原地读）：${census.stayInPlace.length}`);
    for (const item of census.stayInPlace) {
      console.log(`      ${item.env} @ ${item.owner} — ${item.reason}`);
    }
  }
  console.log('');
}

function printNonFamily(report: NonFamilyReport): void {
  const strip = (key: string, problem: string): string =>
    problem.startsWith(`${key}: `) ? problem.slice(key.length + 2) : problem;
  console.log(
    `  NON-FAMILY REGISTRY KEYS — ${report.total}（number/string 与无 env 的 json/enum；存量 report-only）`,
  );
  console.log(`    缺 metadata：${report.existingMetadataGaps.length}`);
  for (const gap of report.existingMetadataGaps) {
    console.log(`      ${gap.key} [${gap.problems.map((p) => strip(gap.key, p)).join('; ')}]`);
  }
  console.log(`    无活 reader：${report.existingNoReader.length}`);
  for (const key of report.existingNoReader) console.log(`      ${key}`);
  console.log(`    直读 env（现有，base 放行）：${report.existingDirectReads.length}`);
  for (const read of report.existingDirectReads) console.log(`      ${read.key} @ ${read.file}`);
  console.log('');
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
    if (result.envCensus) printEnvCensus(result.envCensus);
    if (result.nonFamily) printNonFamily(result.nonFamily);

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
        ' 产品代码新增 process.env 读一律红（boot 名也不例外，读 src/core/config/server/env.ts 解析后的 env；registry 名走 getConfig）；存量与 rename 继承按 base 放行并列出，只有 STAY_IN_PLACE_ENV 的 owner 可新增直读。' +
        ' report-only (exit 0); --strict gates UNREGISTERED / DEFINITION-PROBLEM / NO-READER / ORPHAN-* / DIRECT-ENV-READ / CONST-PROBLEM / UNCLASSIFIED-ENV-READ / DYNAMIC-ENV-READ / REGISTRY-SCHEMA-GAP / BASE-DRIFT.',
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
