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

## P1 修复（第二轮）— 截断不打断公式定界

UserUI 复查发现 P1：`truncate` 是裸 `slice`，excerpt 120 / sub_questions.excerpt 80 /
options.text 60（及 evidence label / 摘要项的 48/120 同路）会把 cap 切在 `$...$` / `$$...$$`
或遗留 `\(...\)` / `\[...\]` 内部，向学习者预览泄漏悬空定界符与裸 TeX。

修复（仅 `kernel/proposals/presentation.ts`，渲染层不动，存储源不重写）：

- `truncate` 改为经 `mathSafeCut(value, cap-1)`：维持原 cap（含 `…`）；若 cap 落点切进某个
  公式 span，回退到该 span 开界符之前（不人为补闭合、不猜测）；cap 未触及任何 span 的
  文本与旧裸 slice 逐字节一致（回归零差）。
- ~~span 识别沿用 pandoc 行内规则~~ **（R2 证伪，已废弃）**：该手写扫描器（125 行）
  与渲染层实际语法（micromark 3.1）不符，见下「R2 修复」。
- 计数/列表/字段形状不变（legacy 仍 null，不转 0）；只影响读侧预览截断。

离线证据（同一脚本 `/tmp/yuk1404-offline-evidence/evidence.ts` 新增 D 节，真实
`loadProposalPresentations` + stub DB，含 raw `prompt_md` 的 evidence-label 路径）：cap
切进公式/切在开符字符之间/切在闭符附近 → 回退无残留定界符；完整公式在 cap 内则完整保留
（含 `\(a+b\)` 恰好收尾）；超长公式降级为仅 `…`；相邻 `$a$$b$` 两段均完整；`\$5` 转义与
两种货币模式逐字节等于旧 slice；跨空行 `$`、code span/fence 内 `$` 不触发回退；📐 代理对
在回退边界完整；legacy 行 null 计数保持。日志 `run-p1fix.log` / 结果 `result.json`，
`ALL YUK-1404 OFFLINE EVIDENCE ASSERTIONS PASSED`。

复核门（本机）：`pnpm typecheck` ✅ exit 0；`pnpm lint` ✅ exit 0（174 条均为存量，
presentation.ts 0 条）；`pnpm build` ✅ exit 0。未跑 full `pnpm test`（规约）。

material limits：公式外的裸反斜杠命令（如未被定界的 `\frac`）不在保护范围（不猜测数学）；
公式本身超过 cap 时摘要可能极短甚至仅 `…`（可接受，优于泄漏半截语法）；未闭合 fence
之后不再识别公式（与 markdown 语义一致，回退仅可能少不会错）。
~~货币美元与真公式歧义按 pandoc 规则判为非公式~~ **（R2 证伪）**：实际渲染层把
`价格 $3 到 $5` 解析为一个 active `$3 到 $` 公式——截断按实际语法回退，不再沿用
「货币不配对」的假前提。

## 边界与遗留

- 无 UI/Start/manifest/DBOS/DB/容器/runtime/provider 调用；无 push/PR/deploy；无子委托。未跑迁移（确认无重叠）。
- material limits：裸公式产出质量未付费验收（见 O1）；占位会话被压制的页码措辞可能留下轻度语法粗糙（如「两块的某页」），属罕见模型泄漏的防御性降级；防御清理不处理中文数字页码（如「第一页」），指令已引导模型写阿拉伯数字形式。

## R2 修复（第三轮）— 手写扫描器替换为渲染层真实 parser（已验证 P1）

独立 R2 SWE review 判定上述手写扫描器为 P1：其语法与渲染层实际管线
（react-markdown → remark-math 6 / micromark-extension-math 3.1）不符，四类已复现
泄漏（parent 探针 `/tmp/yuk1404-r2-parent-math-probe-20261010.ts` 在 59681418 全部
`cuts_math:true` 且 excerpt 悬空）：① 空白包裹 `$ a^2+b^2=c^2 $` 与闭符邻数字
`$a^2$5` 在 micromark 3.1 均为 active math（旧扫描器拒判）；② 偶数反斜杠后 `$` 未转义
（`isEscapedAt` 只看一个字符，错判 `\\$a^2$`）；③ 行内未闭合 ```` ``` ```` 不是 fence
（CommonMark fence 须行锚定，旧扫描器任意位置三反引号即当 fence，后续公式全部失保）；
④ 流式 `$$` 可跨空行、未闭合时延伸到 EOF（旧扫描器遇空行即弃保）。

修复（仅 `kernel/proposals/presentation.ts` + 直接依赖声明，渲染层不动，存储源不重写）：

- 删除 125 行手写扫描器，数学 span 一律取渲染层自家管线产出的 AST
  `inlineMath`/`math` 节点 `position`（unified + remark-parse + remark-math，与
  react-markdown 同一管线、同一默认配置）。为此把已在锁文件中的传递依赖声明为直接
  依赖（`unified@11.0.5`、`remark-parse@11.0.0` 精确 pin；`remark-math@^6` 原有），
  `pnpm install --offline` 仅本地 store，无网络。截断仅在「超长且含 `$`/`\(`/`\[`」时才
  parse；无定界符路径零 parse 开销（实测 1973 字符 parse ≈134µs/次，守卫路径 ≈0.15µs）。
- 遗留 `\(...\)`/`\[...\]` 按渲染层 normalizer（`LATEX_DELIMITED`，math-markdown.tsx）
  逐字镜像保护，用**原始偏移**；normalizer 产出的 guard 空格/块级 reflow 只存在于
  归一化坐标，AST span 逐段分片回映（rewrite 内部由其整段源 span 覆盖），偏移绝不盲移。
- 回退语义不变：维持原 cap（含 `…`）、回退到开界符之前、不合成闭合；无活动 span 触及
  cap 的文本与旧裸 slice 逐字节一致；解析异常时回退到 legacy span 保护，读路径不 500。
- 按实际语法修正两处旧断言前提（旧证据在 596 通过但前提为假）：`$a$$b^2$` 实为**单个**
  inlineMath（size-1 开符不被中间 2 连 `$` 关闭，非「相邻两段」）；旧 q-math-4 fixture
  的 `$x$` 在段落第二行（fence 从第三行行锚定才开始），是 active math 而非「fence 内字面量」。
  货币 `$3 到 $5` 实际配对为公式（见上 material limits 更正）。

离线证据（新目录 `/tmp/yuk1404-renderer-grammar-repair-20261010/`，不覆盖旧日志；期望值
全部由真实 parser AST 派生，零手工前提）：

- `preserved-invariants.ts`：原 82 断言 A/B/C/D 全保留（仅上述两处假前提断言按实际语法
  改写并注明原因）——`ALL PASSED`。
- `grammar-repair-evidence.ts`：四 R2 形 + 货币跨越 + `$$$` 连跑（caps 120/80/60）经真实
  `loadProposalPresentations` 与 parser 派生期望全等；raw48（未折叠 prompt_md）覆盖流式
  `$$` 跨空行 [41,53)、未闭合到 EOF、行锚定 4 反引号 fence、奇反斜杠转义、独立 code
  span 的逐字节 plain；legacy 原始偏移（含 `$\(a\)$` 邻接）不泄漏；纯文本四 cap 逐字节
  plain；E6 断言 596 基线探针日志四例全部泄漏、修复后零 `$` 泄漏——`ALL PASSED`。
- parent 探针 before/after 日志：`probe-before-fix-596.log` / `probe-after-fix.log`。

复核门（本机，offline env wrapper）：`pnpm typecheck` ✅ exit 0；`pnpm lint` ✅ exit 0
（174 条均为存量 warning，presentation.ts 0 条）；`pnpm build` ✅ exit 0（含 migrate
bundle；`dist/migrate.cjs` 不含 parser——不可达，unified/remark-parse/micromark 无
`import.meta`/`fileURLToPath` 顶层使用，`dist/server.cjs`/`dist/worker.cjs` 的 12/13 处
`fileURLToPath` 与 596 基线完全一致，非新增）。未跑 full `pnpm test`（规约）；未新增仓库
内测试（不触五类不变量；读侧展示合同由离线证据覆盖）。R2 coverage 仅读 + parent 四例
真实复现，无 DB/TEST/model 质量承认。
