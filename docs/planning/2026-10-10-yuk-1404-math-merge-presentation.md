# YUK-1404 — 录取公式定界 + 题块合并理由学习者化 + 提议块预览计数（实施报告）

日期：2026-10-10 · 分支：`fix/yuk-1404-math-merge-presentation`（自 main `81efd7da2`）
工作树：`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1404-math-merge-presentation`

## O1 — StructureTask 公式显式定界（生产侧）

已定决策：抽取题干存储显式 `$行内$` / `$$展示$$` 公式；渲染层不改动，不加无定界公式启发式。

- `ingestion/tasks/structure.ts`：`buildStructurePrompt` 新增「关键能力 5 · 数学公式定界」——要求 `prompt_text`、`options[].text`、`sub_questions` 题面中的公式带 `$...$` / `$$...$$` 定界；已定界公式（含 `\(...\)`、`\[...\]`）原样保留；代码（Python/缩进/反斜杠）与普通文字不包 `$`；拿不准保持原样、宁可不包。`answers` / `analysis` 明确排除。
- `ingestion/server/structure.ts`：`nodeToStructured` 在规范映射处新增 `canonicalizeExplicitMathDelimiters` —— 仅把**已显式定界**的 `\(...\)`→`$...$`、`\[...\]`→`$$...$$`（应用于 `prompt_text` 与 `options[].text`，子问随递归覆盖；`answers`/`analysis` 不动）。正则镜像渲染层已验证的 `LATEX_DELIMITED`（`src/ui/lib/math-markdown.tsx`）：代码 span/fence 优先返回、前置反斜杠（LaTeX 换行）不是开界、公式不跨空行/反引号、相邻 `$` 加保护空格。**不猜测包裹任何裸文本**；无自动重试/cascade；不伪造验证。
- 离线证据曾抓到一次真实缺陷：初版正则漏了渲染层的 `(?:...)` 非捕获包裹，捕获组只留最后一个字符（`\(x^2+1\)`→`$1$`）。已修复为与渲染层逐字一致，见下「证据」。
- **未验证声明**：裸公式（模型未按指令定界）的实际产出质量**未经付费 sealed gold 验收，保持未验证**。旧数据行不回填、不动。

## O2 — BlockAssembly 理由学习者化

- `ingestion/tasks/block-assembly.ts`：输入说明改为 `page_index（0-based：0 = 第 1 页，1 = 第 2 页…）`；`reason_md` 指令要求用 1-based「第 1 页/第 2 页」引用页码并指明题号/块位，示例「第 5 题在第 1 页末尾，其子问从第 2 页开头延续」；**禁止** `block_id`、`page_index` 字段名或其他不透明 ID/内部字段名；无 page_index 输入时不谈页码。
- `ingestion/server/block-assembly.ts`：`humanizeBlockMergeReason`（原仅屏蔽 ID）新增确定性页码清理（无新增模型调用）：
  - 字段锚定 `page_index … <n>` 仅当会话有真实空间数据**且** n ∈ 该会话首 span 页索引集合时转换为「第 n+1 页」；越界值（幻觉映射）降级「某页」。
  - 全占位会话（Tencent 路径，模型从未见过页码）压制一切具体页码声明：叙述式/列举式「第 N 页」→「页面」，字段锚定 span →「某页」，残余 `page_index` 字段名 → 「页码」。
  - 正确的既有来源标签（第 N 块/题号）原样保留；真实空间会话中有据的叙述式页码引述逐字保留。

## O3 — ProposalBlockPreview 增量扩展（Opus UI 合同）

`kernel/proposals/presentation.ts`（+ `shell/api/contracts.ts` 同步 wire schema + 再生成 `src/ui/lib/api-schema.generated.ts`）：

```ts
interface ProposalBlockPreview {
  id: string; label: string; excerpt: string;          // 既有字段不变
  sub_question_count: number | null;                   // 真实结构化总数；legacy 无 structured → null
  option_count: number | null;
  sub_questions: { label: string; excerpt: string }[]; // ≤3 项，excerpt ≤80 字
  options: { label: string; text: string }[];          // ≤4 项，text ≤60 字
}
```

- 命名上限：`BLOCK_SUB_QUESTION_PREVIEW_MAX=3`、`BLOCK_OPTION_PREVIEW_MAX=4`、`SUB_QUESTION_EXCERPT_CAP=80`、`OPTION_TEXT_CAP=60`（与既有 `BLOCK_EXCERPT_CAP=120` 同风格）。
- **计数恒为真实总数，列表为截断预览**：截断时 `count !== list.length`，UI 不得把列表长度当全量。
- 投影只含学习者 label + 摘要/文本；**不含** answers/analysis/参考解析/学生作答/PII。UI 无需解析组件。既有 `id/label/excerpt` 兼容；`evidence_labels` 不变。

## 证据（确定性离线，无 DB/无 provider/无网络）

脚本：`/tmp/yuk1404-offline-evidence/evidence.ts`（仓库外）；结果：同目录 `result.json`、`run-final.log`（`ALL YUK-1404 OFFLINE EVIDENCE ASSERTIONS PASSED`）。走**真实生产函数**：`runStructureTask`（注入假 runTaskFn）、`loadProposalPresentations`（stub drizzle select 链）、`humanizeBlockMergeReason`。关键断言：

- 公式：`\(x^2+1\)`→`$x^2 + 1$`、`\[\int…\]`→`$$…$$`；代码 fence 内 `\(not math\)` 与 `\\` 反斜杠原样；已有 `$y_1$` 原样；`\\(x\\)`（换行前缀）不动；options 同步转换；**answers/analysis 保持 `\(...\)` 原样**。
- 预览：完整 fixture（2 子问 + 4 选项）→ 计数 2/4、列表 2/4 且仅 label/excerpt|text 键；无 question_no 子问回退「第 2 问」；超限 fixture（5 子问/6 选项）→ 计数 5/6 vs 列表 3/4（计数≠列表长）；legacy `structured:null` → 计数 null、列表空、excerpt 回退 `extracted_prompt_md`；解析/学生作答字段不出现在投影 JSON。
- 理由：真实空间会话 `page_index: 0→1` 转「第 1 页→第 2 页」、越界 `page_index: 9`→「某页」、有据叙述页码逐字保留；占位会话「第 1 页末尾…跨第 1、2 页」→「页面末尾…跨页面」，无任何具体页码幸存。

## 检查

`pnpm install --frozen-lockfile`（新工作树，无 lockfile 漂移）→ `pnpm typecheck` ✅ → `pnpm lint`（175 条均为存量 warning；本次 6 文件 0 error，新代码 1 warning 已修）✅ → `pnpm build` exit 0（web/start/server/worker/migrate 全部产出）✅ → `pnpm gen:api-client`（增量 40 行）✅ → `pnpm gen:postman`（no-op diff，未改路由/请求）✅ → `pnpm audit:api-client` 在提交前 diff 非空属预期（重生成为确定性同 blob，随本提交落库后即绿）。未跑 full `pnpm test`（按规约）；未新增测试（不触五类不变量；投影安全属读侧展示合同，由离线证据覆盖）。

## 边界与遗留

- 无 UI/Start/manifest/DBOS/DB/容器/runtime/provider 调用；无 push/PR/deploy；无子委托。未跑迁移（确认无重叠）。
- material limits：裸公式产出质量未付费验收（见 O1）；占位会话被压制的页码措辞可能留下轻度语法粗糙（如「两块的某页」），属罕见模型泄漏的防御性降级；防御清理不处理中文数字页码（如「第一页」），指令已引导模型写阿拉伯数字形式。
