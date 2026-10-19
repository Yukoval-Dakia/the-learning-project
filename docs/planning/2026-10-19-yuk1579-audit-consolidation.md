# YUK-1579 — audit 扫描器机制归并（draft-status 家族 + schema/fold/hub-sync）

日期：2026-10-19 · 分支：`refactor/yuk-1579-audit-consolidation`（自 origin/main `696449125` 切出）
证据目录（仓库外）：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1579/696449125/{before,after}/`

## 1. 语义重叠地图（先评估，后动手）

五个 audit 的**策略**各不相同（表/谓词/写者所有权/schema 健康），但它们的**机制**大量重复：

| 重复机制 | draft-status | draft-status-reads | schema-writes | fold-writes | hub-sync-writers |
|---|---|---|---|---|---|
| 递归源码 walk | 私有 walkSource | 同一函数的逐字拷贝 | 私有 walkFiles（绝对路径、不跳测试） | 私有 walkSource（自排除） | 私有 listSourceFiles（跳 generated） |
| 注释/字符串 lexer | ts-tokenize（共享✓） | ts-tokenize（共享✓） | TS compiler AST | **私有 100 行状态机 stripComments** | 私有 codeText（选择性保留字符串，不同策略） |
| lineOf 行号 | 私有拷贝 | ts-tokenize 共享✓ | — | 内联 lineAt | — |
| resolves_when allowlist 加载 | 私有 loadAllowlist | 逐字拷贝 | 私有（返回 unknown，不同策略） | 私有（容错回退 {}） | 不同 schema（writers 数组） |
| isRecord | ✓ | ✓ | ✓ | — | — |
| CLI-gate 尾部 | ✓ | ✓ | ✓ | ✓ | ✓ |

## 2. 归并的簇（同 PR 内有 5 个 live consumer）

新建 `scripts/lib/audit-scan.ts`（145 行）：

- **`walkSourceFiles(repoRoot, opts)`** — 唯一的源码遍历器。每个 audit 的扫描宇宙
  （roots、排除目录、是否跳测试/generated/.d.ts、自排除文件、绝对/相对路径、缺根跳过还是抛错）
  以显式 options 对象留在各自调用点，互不继承。5 个私有 walker（约 106 行）删除。
- **`loadResolvesWhenAllowlist(path)`** + `RESOLVE_KINDS/ResolvesWhen/AllowlistEntry` —
  draft-status 家族两份逐字拷贝的加载器合一。
- **`isRecord`**（3 拷贝→1）、**`isDirectCliInvocation(metaUrl)`**（5 个 CLI-gate 尾部→1）。

`scripts/lib/ts-tokenize.ts` 增加 **`stripComments(src)`** 派生视图：保留字符串内容、保留注释内
换行（行号对齐），由 `analyzeSource` 的 codeMask/commentMask 直接投影（13 行）。fold-writes
的 100 行私有状态机删除，改为 `export { stripCommentsShared as stripComments }` 保模块面。
**一个 lexer 服务 5 个 audit 中的 3 个**（draft-status 两个 + fold-writes）。

fold-writes 的 `lineAt` 内联闭包、draft-status 的私有 `lineOf` → 统一用 ts-tokenize 已导出的 `lineOf`。

**caller knowledge 移除**：各 audit 的 main/auditFoldWrites 不再知道"怎么遍历仓库、怎么剥注释、
怎么算行号、怎么解析 resolves_when JSON、怎么判断直启 CLI"，只知道自己的扫描策略对象。

**旧职责确实被移除（deletion test）**：删掉 audit-scan.ts 则 5 个 audit 全部编译失败（遍历/
加载/CLI-gate 无处可来）；删掉 ts-tokenize 的 stripComments 则 fold-writes 与 draft 家族同时失去
词法层。无 pass-through 包装存活（曾保留的 walkSource 委托已删——外部零 consumer，经 grep 验证）。

## 3. 排除项（有证据的不相似面）

- **hub-sync 的 `codeText`（~180 行）不并入 ts-tokenize**：它的策略是*选择性*保留字符串
  （仅 sql`` 模板、actorRef 字面量、sql.raw 参数），并做 regex 字面量识别与结构性回看
  （previousWord/isActorRefValue/followsControlCondition）。analyzeSource 的掩码不携带这些
  上下文；在其上重建需要原样搬移结构回看代码——净删除≈0 且覆盖面有风险。仅其 walker 迁移。
- **schema-writes 的富版 `validateAllowlistHygiene` 不与 draft-status 的形状校验合并**：前者含
  过期/12 个月视界/merged-PR git-log/shipped-phase status.md 检查与 9 种 issue code——不同策略
  含义、不同输出契约（任务红线：不合并不同 policy meaning）。fold-writes 的
  `validateAllowlistEntry` 同理（消息串与 AllowlistProblem 形状不同）。
- **两个 `readFileOrNull` 不合并**：reads 版非 ENOENT 重抛、fold 版全吞——故障语义不同，各自保留。

## 4. 两个真实维护变更场景（before/after）

1. **新增需剪枝的构建/供应商目录**（如 `.turbo`）：before 要在 5 个文件的 5 个私有 walker 里各改
   一处，漏一处则该 audit 扫进供应商产物（误报/规模失控）；after 只改各 audit 调用点的
   excludeDirs 选项，遍历代码只有一份。
2. **lexer 缺陷修复**（嵌套模板字面量提前终止——旧 fold-writes 状态机的真实缺陷：模板
   `${...}` 内再出现反引号会提前结束模板态）：before 需在 ts-tokenize 与 fold-writes 两套不同
   内部实现的词法器里分别修；after 一处 analyzeSource 修复全员受益——本 PR 即免费修掉了该缺陷
   （当前语料行为不变，见 §6）。

## 5. 保留的行为（故障/兼容）

- **缺根语义**：draft 家族 walker 缺根仍抛错（未设 skipMissingRoots）；fold/schema/hub-sync 仍跳过。
- **allowlist 故障**：draft 家族 JSON.parse 抛错、schema 缺文件返回 {}、fold 记日志回退 {}、
  hub-sync 带信息抛错——逐一并原样。
- **exit code 与输出确定性**：11 个命令变体（5×text、5×JSON、reads --strict）输出与退出码
  全部逐字节一致（全部 0）。fold-writes 在 main 上本就报告 8 条 report-only VIOLATION
  （含 corpus.ts rehearsal 写点与 edit-question.ts/note-verify-durable-operation.ts）——原样保留，
  非本重构引入，归 owner 既有漂移。
- **CI gating 语义零改动**：package.json、workflow、全部测试文件只读未动。

## 6. 覆盖等价性的限定（诚实边界）

- 行走器由 statSync 换 withFileTypes：符号链接语义不同（前者跟随、后者跳过）。已验证
  src/server/scripts/app 四根下 symlink 数为 0，输出逐字节一致。
- stripComments 派生视图与旧状态机的两处词法差：模板 `${...}` 内插中的注释现在被正确剥离
  （旧版保留）；嵌套模板深度现在正确（旧版提前终止）。两形态在当前扫描根下零出现，输出
  逐字节一致；等价性是**当前语料验证**，非对未来文件的形式证明。
- pnpm install 噪音：before/draft-status.txt 首行含冷启动 install 日志（102 行），审计正文
  自 "draft-status gate audit" 起逐字节一致；JSON 完全一致。

## 7. 度量（真实净额）

- 修改 6 文件：+132 / −292（净 −160）；新增 scripts/lib/audit-scan.ts +145；
  **总计 +277 / −437，净 −160 行**，且每个重复机制现存 exactly once：
  5 walker→1、fold-writes 100 行状态机→13 行派生视图、3 lineOf→1、2 allowlist 加载器→1、
  3 isRecord→1、5 CLI-gate→1。

## 8. 验证与 NOT_RUN

已跑（本 worktree，`refactor/yuk-1579-audit-consolidation`）：

- `pnpm audit:draft-status[ --json]`、`pnpm audit:draft-status-reads[ --json][ --strict]`、
  `pnpm audit:schema[ --json]`、`pnpm audit:fold-writes[ --json]`、`pnpm audit:hub-sync-writers[ --json]`
  ——与 origin/main 基线（同 worktree、同 HEAD 起点）输出/退出码逐字节一致；
- `pnpm typecheck` exit 0；`pnpm lint` exit 0（179 warnings = main 既有基线）；
  `pnpm build` exit 0。

NOT_RUN：完整 `pnpm test`（owner 规则：由 push 后 exact-head CI Gate 执行）；任何测试编写/
修改（未获批准）；DB/Docker/runtime/provider/paid 动作。父线负责独立 review、PR、CI。
