# YUK-1579 — audit 重复机制归并（修正版）

日期：2026-10-19 · 分支：`refactor/yuk-1579-audit-consolidation`（基 origin/main `696449125`，已普通 merge 至 `4690ef533`）
证据（仓库外）：`tlp-audit-artifacts/architecture-deepening/YUK-1579/696449125/{before2,after2,progress.md}`
本文取代同 PR 内早期版本；早期版本宣称的"唯一 walker/唯一 lexer/净 −160"有计算与事实错误，见 §4。

## 1. 五个 audit 的语义重叠地图

| 重复机制 | draft-status | draft-status-reads | schema-writes | fold-writes | hub-sync-writers |
|---|---|---|---|---|---|
| 源码 walk | 私有 walkSource | **逐字拷贝** draft-status 的 | 私有 walkFiles（statSync、跟 symlink、不跳测试） | 同构 walkSource（+自排除+容错缺根） | 私有 listSourceFiles（statSync、跟 symlink、跳 generated） |
| 注释/字符串 lexer | ts-tokenize 共享 | ts-tokenize 共享 | TS compiler AST | 私有 stripComments 状态机 | 私有 codeText（选择性保留字符串） |
| lineOf | 私有拷贝（=ts-tokenize 导出） | 已用共享 | — | 内联 lineAt（同实现） | — |
| resolves_when 加载 | 私有 loadAllowlist | **逐字拷贝**（仅路径常量不同） | 私有（返回 unknown） | 私有（容错回退） | 不同 schema |
| isRecord / CLI-gate | ✓ | ✓ | ✓ | — / ✓ | — / ✓ |

## 2. 最终交付（仅逐字重复簇，骑现有 seam，无新模块）

reads 本就 `import ... from './audit-draft-status'`（YUK-569 先例：validateAllowlistHygiene）。
本轮把 reads 里 draft-status 的三份逐字拷贝改为经该现有 import 边复用：

- `walkSource`：reads 删除 18 行逐字拷贝，import draft-status **既有导出**（两文件 EXCLUDE_DIRS
  常量逐字相同、同为 Dirent 语义、同为 repo-relative 输出）。
- `loadAllowlist(path)`：参数化并导出（原 zero-arg 读模块常量）；reads 删 10 行逐字拷贝，
  传自己的 ALLOWLIST_PATH。readFileSync/JSON.parse 的抛错面不变（同一函数体）。
- `type AllowlistEntry` + `isRecord`：导出复用，reads 删本地类型块与拷贝。
- `lineOf`：draft-status 删私有拷贝（与 ts-tokenize 导出逐字相同）、fold-writes 的 `lineAt`
  闭包改为调用同一导出——纯函数，函数体逐字相同。

**净额（git numstat vs origin/main `4690ef533`）**：scripts +29/−70 = **净 −41**：
reads +14/−46、draft-status +9/−14、fold +6/−10；schema-writes / hub-sync-writers /
ts-tokenize 与 main 逐字节相同；无新增文件。

## 3. 行为保持（分支级论证，非"当前输出相同"）

- `walkSource`/`loadAllowlist`/`lineOf`/`isRecord`：reads 调用的是**同一函数体**（原先的逐字
  拷贝换成原身）。对任意输入等价由构造保证：相同参数→相同执行路径；draft-status 的
  REPO_ROOT/EXCLUDE_DIRS 与 reads 原常量逐字相同。
- 缺根/不可读目录、symlink、allowlist 损坏等故障分支：未触碰任何 walker/lexer/加载器本体
  （schema/hub/fold 的实现与 main 逐字节相同；draft-status 侧仅签名参数化）。
- 11 个命令变体（5×text、5×JSON、reads --strict）在同一树上原版 vs 归并版输出与退出码
  逐字节一致（全部 0；fold-writes 的 8 条 main 既有 report-only VIOLATION 原样）。

## 4. 尝试过并退掉的方案（保留教训）

1. **共享 walker（scripts/lib/audit-scan.ts walkSourceFiles + 显式 options）**：把 3 个
   Dirent walker 合一并显式化各 audit 政策后，模块+接线成本高于删除量（净 +49）；且
   schema/hub 的 statSync walker **跟随 symlink** 而 Dirent walker 跳过——属审计覆盖行为
   变化，当前语料 0 符号链接不能证明行为保持。已整体退掉，两 audit 与 main 逐字节相同。
2. **fold-writes stripComments 改为 ts-tokenize 派生视图**：模板 `${...}` 内插注释剥离、
   嵌套模板深度两处判定变化，同样是覆盖行为变化。已还原原状态机（与 main 逐字相同，
  diff 校验过）。
3. 早期报告的"净 −160"把新增 145 行模块算进删除侧，属计算错误；"删 helper 致编译失败=深度"
   的 deletion-test 论证不成立（ts-tokenize stripComments 的删除并不影响未使用它的 draft
   审计）。均已纠正。

## 5. 两个维护变更场景（before/after）

1. **draft-status walker 变更**（如调整排除目录或过滤器）：before 要同步改 reads 的逐字
   拷贝，漏改即两 audit 扫描宇宙静默分叉；after reads 自动跟随（同一函数）。
2. **resolves_when 加载约定变更**（如 `_` 前缀规则）：before 双实现各改一份；after 单实现。

## 6. 剩余未合的重复（地图结论）

五 audit 间其余"相似"均为不同策略或合并不净减：三种 walker 机制（Dirent×2 形、statSync×2）、
两套 lexer（fold 私有状态机、hub codeText 选择性保留）、四套 allowlist 校验（不同 issue 形状
与消息契约）。按"不合并不同 policy meaning、不为统一引入净增接口"红线保持本地。

## 7. 验证与 NOT_RUN

已跑（最终树）：11 变体同树对照逐字节一致（before2/after2）；`pnpm typecheck` 0；
`pnpm lint` 0（179 warnings = main 基线）；`pnpm build` 0。
NOT_RUN：完整 `pnpm test`（owner 规则，push 后 exact-head CI Gate 执行）；未写/改任何测试；
无 DB/Docker/runtime/provider/paid 动作；未 push、未 PR。
