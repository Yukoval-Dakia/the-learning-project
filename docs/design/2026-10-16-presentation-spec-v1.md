# 题目展示 spec v1（Generative UI 积木与作答绑定）

2026-10-16，Stage「第一天能用」，YUK-1497（Generative UI），依赖 YUK-1496（统一判分契约）。
来源：`tlp-status/discussions/unified-question-grading-design.md` §8，以及 `stage1-day-one-scope.md` 的「10-15 范围更正」中的 K5。

本文固定后端与界面之间的展示契约。分工如下：
- 后端（K5 后端批）实现：类型、发布时的绑定校验、公开投影，以及录入 agent 生成展示的工具。
- 界面线（仅 Opus）实现：积木渲染器，以及作答卷 PDF 投影。

展示不参与判分。判分只读作答信封，不读积木文案。

## 1. 形状

题目 revision 新增一层冻结的 `presentation`，它是公开内容：

```ts
Presentation = {
  schema_version: 1,
  renderer_contract: 'blocks-v1',
  root: Block,
}
```

每个 Block 都有一个在本 presentation 内唯一的 `block_id`，按 `kind` 区分。

### 1.1 布局与内容积木（不收作答）

| kind | 字段 | 渲染 |
| --- | --- | --- |
| `stack` | `children: Block[]`，`gap?: 'sm'\|'md'\|'lg'` | 纵向排列 |
| `passage_layout` | `material_ref`（passage 或内联 plaintext 材料），`layout: 'passage_left_questions_right'\|'passage_top'`，`passage_width?: 'balanced'\|'wide'`，`children: Block[]` | 文章常驻（文左题右或文上题下）；children 是问题区（review R1 更正：归一器只铸造内联 plaintext 材料，不产 passage kind，故两者都接受，须带 `content_md` 且公开） |
| `text_math` | `part_ref` 或 `material_ref`，二选一 | 渲染该 part 的 `prompt_md` 或该材料的 `content_md`（MathMarkdown） |
| `figure` | `material_ref`（kind=figure） | 渲染已核验的图资产 |

积木本身不带任何自由文字，文字只来自引用的 part 和材料。这样展示层没有地方写进答案或细则。

### 1.2 输入积木（每个恰好绑定一个作答位）

所有输入积木都带 `bind: { unit_id, slot_id, response_class: 'select'|'blank'|'free' }`。可选的 `print?: { height_mm?: number }` 只给 PDF 投影用，用来预留作答区高度。

| kind | 绑定的槽 | 对槽的要求 | 交出的作答 |
| --- | --- | --- | --- |
| `option_list` | `select` | items 没有 coordinates 和 gap，`pick` 决定单选/多选外观 | 选中的 `item_ids` |
| `matching_columns` | `select` | `axes` 恰好是 `left`、`right`，items 带 coordinates | 每连一对，按 `(left,right)` 找到对应 item，交它的 `item_id` |
| `break_tap` | `select` | 有 `text`，items 带 `gap_after_codepoint` | 点中的字缝对应的 `item_ids` |
| `ordering` | `select` | `axes` 恰好是 `position`、`object` | 每个位置放一个对象，交对应关系 item 的 `item_id` |
| `blank_input` | `blank` | — | `text`（原样，不做归一化） |
| `free_area` | `free`（即 `open_response` 槽） | — | `text_md` 和照片等附件 |

### 1.2.1 两处精确语义

**break_tap 的字缝位置。**
- `gap_after_codepoint` 按 Unicode 码点（code point）计数，和 `position-gap.ts` 一致。不按 UTF-16，也不按字素簇。
- 界面只为 universe 里**声明过**的字缝 item 渲染点选位，不自己枚举全部字缝。
- 声明的字缝必须落在字素簇边界上；组合字符、emoji 内部不能是字缝。这一条由后端绑定校验拒绝。

- 文本含换行 `\n` 时：紧跟在 `\n` 之后的字缝不合法，它和换行前的那个字缝表示同一个位置，会产生歧义，后端拒绝。行末断句用 `\n` 之前的字缝，界面把它画在行尾。

**ordering 的关系表达。**
- 每个可放置的 `(position, object)` 组合是一个 item，可以是全积，也可以是子集。
- 「一个位置一个对象、一个对象一个位置」写成 `at_most_per_coordinate: {position: 1, object: 1}`。
- 没排完的作答也合法，缺项计为 miss。

字段：`option_list.layout?: 'vertical'|'grid'|'inline'`、`option_list.marker?: 'letter'|'number'|'none'`、`blank_input.width?: 'sm'|'md'|'lg'`、`free_area.min_lines?: number`。
- `marker` 只影响显示。item_id 永远不由显示字母推出。
- 选项显示顺序按 issuance 冻结的 `option_order`。没有 option_order 时按 items 声明顺序。

### 1.3 自定义块（沙箱，排在声明式积木之后，同属本阶段）

```ts
{ kind: 'custom', block_id, sandbox: { asset: { asset_id, digest }, entry: string, contract: 'sandbox-v1' }, binds: Bind[], frame_height_px?: number }
```

（v2，2026-10-17：回应沙箱安全审查 APPROVE-WITH-CHANGES 与协调线裁决，见 `tlp-status/discussions/custom-block-sandbox-plan.md` 修订版 v2。）

- **运行限制**：无网络、无学习者数据、拿不到私有答案。
- **资产**：代码作为 `source_asset` 资产冻结，随 presentation 版本化。`digest` 固定为 `sha256:<64 位小写 hex>`，必须等于资产行的 `sha256`（即 `'sha256:' + source_asset.sha256`）；`unverified:` digest 永不可发布。mime 限 `text/javascript` 或 `application/javascript`，`byte_size` ≤ 256 KiB。
- **内容寻址（v2）**：`asset_id` 必须等于 `sbx_` + digest hex 前 32 位，由 digest 推导；配上发布时「资产行 sha256 与 digest 相符 + 字节实测 sha256 与资产行相符」，id ↔ 字节绑定不可变。资产 writer 随 R8（录入 agent）落地：服务端算 sha256、一次写入（`ON CONFLICT DO NOTHING`）；本 PR 不建 writer（无 live consumer）。
- **代码获取**：复用 `GET /api/assets/[id]/content`，不新建路由。同源、internal token 后面，返回存储字节，带 `X-Content-Type-Options: nosniff`。JS 代码资产按惰性表示服务：`Content-Type: text/plain; charset=utf-8` + `Content-Security-Policy: sandbox; default-src 'none'` —— 页面只 fetch 字节、核对 SHA-256，内容类型对它无关紧要；同源下发 `text/javascript` 会让本源任意 `<script src>` 以完整源权限执行 agent 生成的代码。图片等其它资产照旧返回存储 `mime_type`（加 nosniff）。OpenAPI 对 200 声明 `image/*` 与 `text/plain`。取回字节、核对 SHA-256 与 digest 相符后才注入沙箱 iframe —— 这一步在界面线。
- **entry**：代码资产定义的一个全局函数名（非空 JS 标识符，≤64 字符）。宿主在沙箱内调 `globalThis[entry](port)`；port 只能为 `binds` 内的槽位交出作答条目。
- **输出**：只能通过宿主发出与 1.2 相同的作答信封，宿主再按 universe 校验。不返回分数，不查判分。
- **binds**：一个自定义块可以绑定多个作答位。每个作答位仍然只被一个积木绑定。
- **禁序（v2，N4 补充）**：代码含 `</script`（不分大小写）、`<!--` 或 NUL 字节（\u0000）会提前终止/破坏外层 script —— 发布 barrier 读字节后拒绝（`custom_code_forbidden_sequence`，detail 点名命中的序列），界面侧同样拒绝加载。
- **frame_height_px（v2）**：可选整数，120 ≤ 值 ≤ 720；缺省 UI 取 320。高度只来自块声明，iframe 自身永远改不了它。
- **校验分工**：纯校验在 `validatePresentation`（`custom_contract_unsupported` / `custom_asset_digest_invalid` / `custom_asset_unverified` / `custom_asset_not_content_addressed` / `custom_entry_invalid` / `custom_binds_empty` / `custom_frame_height_invalid`，加既有 bind 规则：槽存在、response_class 相符、unit 含该槽、覆盖恰一次）；DB + 字节校验在 `publishQuestionGroup` 的 presentation barrier（资产行存在、sha256 与 digest 相符、mime、大小、字节可读且实测 sha256 相符、禁序扫描；字节读取经调用方注入的 `readAssetBytes`（既有 R2 client），含 custom 块而未供 reader 时 fail-closed 拒发），任一失败整组不能发布。
- 隔离方式（iframe 或 Worker）由界面线选定。

#### 1.3.1 上线路径（custom 块可被服务前必须具备）

- **无头预演准入**：把块放进限时、限内存的无头浏览器预演；死循环、内存超限、加载时抛错、或未能对 `binds` 里每个槽发出合法信封，一律拒绝准入。随 R8（录入 agent）落地。
- 在那之前，serving gate 维持 custom 绑定槽 withheld（现状，界面线 `INPUT_RENDERER_SLOT_KINDS` 不动）。

### 1.2.2 界面行为约定（10-16 裁决）

- **冲突处理**：ordering 里把已放置的对象移到新位置，直接移动，不弹确认。matching 按 R10，先提示占用，再给「改配给 X」。两者不同是有意的。
- **判后对错**：点选积木（option_list / matching_columns / break_tap / ordering）提交后不在积木上着色，按 R10 执行。结果只在题目层面用现有反馈显示，比如徽标、得分和揭示的答案。积木可以留着可选的 `outcome` 参数，做题页不传。
- **blank 留空**：没有单独的「我留空」按钮。网页提交整题时，空字符串的 blank 交 `state: 'blank'`，和现有文本槽的空串语义一致。自动保存草稿时，空字符串不写条目。`unknown` 只由回收侧产生。
- **max_chars / format:'math'**：`max_chars` 只显示计数，不阻止输入和提交。`format: 'math'` 在输入框下方用现有 KaTeX 渲染做预览。
- **读屏名称**：不用 `label_md` 的源码当 aria-label。可访问名称来自渲染后的内容，KaTeX 输出带 MathML，后端不另给纯文本字段。
- **积木的读屏标签**：由适配层拼成三段：所绑 part 的 `question_no`（如「(2)」），加槽的 `placement.label`（有就加），加积木种类名（选项 / 配对 / 断句 / 排序 / 填空 / 作答区）。

## 2. 作答信封（网页与 PDF 相同）

作答就是现有 ResponseSet 的条目，定义在 `src/core/schema/assessment/response.ts`：

```ts
{ slot_id, kind: 'select', state: 'answered'|'blank'|'unknown', item_ids: string[] }
{ slot_id, kind: 'blank',  state: 'answered'|'blank'|'unknown', text: string }
{ slot_id, kind: 'open',   text_md, evidence: EvidenceAttachment[] }   // free
```

- `blank` 表示学生主动留空，此时内容必须为空。网页「提交整题」时，每个绑定了但空着的作答位都交 `blank`（见 §1.2.2）。
- `unknown` 表示拍照或作答卷上看不清，只由回收侧使用。网页提交入口会拒收 `unknown`。
- 没有条目表示未作答，只出现在三种情况：草稿、回收侧没读到某一空、部分发题。
- 重复或不在 universe 里的 id 是协议错误，提交会被拒绝。选多、选错是有效作答，交给给分规则处理。
- 一对一配对等结构约束由槽上的 `at_most_per_coordinate` 声明，提交时校验。
- 同一道题换一种布局（例如 option_list 从 vertical 改成 grid，或断句放进 passage_layout 与否），交出的信封完全相同，判分也相同。

## 3. 发布时的绑定校验（后端，在唯一发布口 `publishQuestionGroup` 的同一道校验里）

1. 发出的 part 里，每个可作答槽恰好被一个输入积木（或自定义块的一项 bind）绑定。不漏，也不重。
2. `bind.response_class` 与槽种类一致：select↔`select`，blank↔`blank`，free↔`open_response`。
3. `bind.unit_id` 是一个计分单元，且该单元的 `slot_refs` 包含 `bind.slot_id`。
4. 输入积木种类与槽形态相容，见 1.2 表的「对槽的要求」。
5. `part_ref` / `material_ref` 都能解析；figure 材料是已核验的公开材料。
6. block_id 唯一；kind 在白名单内；`renderer_contract` 是受支持的版本。break_tap 绑定的字缝都在字素簇边界上（`Intl.Segmenter`），且不紧跟在 `\n` 之后。
7. 不合格就不能发布。旧 revision 没有 presentation，继续用现有的逐槽渲染。

公开投影：issuance 只出它发出的 parts。积木树里引用未发出 part 或单元的分支整枝去掉。presentation 只含引用，不需要另做脱敏。

## 4. 出题门

`src/core/schema/assessment/serving-admission.ts` 的 `INPUT_RENDERER_SLOT_KINDS` 是网页已有输入控件的槽种类。

- 界面线某种输入积木接进做题页时，在同一个 PR 里把对应槽种类加入名单。`select` 与 `blank` 需要 option_list / matching_columns / break_tap / ordering / blank_input 全部可用，或者按积木粒度另行细分。
- 在那之前，这些题不出，原因记为 `no_input_renderer`。

## 5. 谁生成

- 录入 agent 入库时为每道题生成 presentation：先用声明式积木，必要时用自定义块。
- 生成走 K5 后端提供的工具，经同一个编辑与提交入口和同一道绑定校验。
- 重新生成展示是新的展示版本。判分指纹不变时，判分证据可以复用。

## 6. 验收（10-15 更正原文）

- 同一道题用两种合法布局实际提交，得到相同判分。
- 至少一道由 agent 生成展示的真实录入题，在网页与 PDF 上作答。
- 证据来自现有产品的截图、录屏和原始作答信封，不另建展示入口。
