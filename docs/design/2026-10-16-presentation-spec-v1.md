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
| `passage_layout` | `material_ref`，`layout: 'passage_left_questions_right'\|'passage_top'`，`passage_width?: 'balanced'\|'wide'`，`children: Block[]` | 文章常驻（文左题右或文上题下）；children 是问题区 |
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

字段：`option_list.layout?: 'vertical'|'grid'|'inline'`、`option_list.marker?: 'letter'|'number'|'none'`、`blank_input.width?: 'sm'|'md'|'lg'`、`free_area.min_lines?: number`。
- `marker` 只影响显示。item_id 永远不由显示字母推出。
- 选项显示顺序按 issuance 冻结的 `option_order`。没有 option_order 时按 items 声明顺序。

### 1.3 自定义块（沙箱，排在声明式积木之后，同属本阶段）

```ts
{ kind: 'custom', block_id, sandbox: { asset: { asset_id, digest }, entry: string, contract: 'sandbox-v1' }, binds: Bind[] }
```

- **运行限制**：无网络、无学习者数据、拿不到私有答案。
- **资产**：代码作为资产冻结，带 digest，随 presentation 版本化。
- **输出**：只能通过宿主发出与 1.2 相同的作答信封，宿主再按 universe 校验。不返回分数，不查判分。
- **binds**：一个自定义块可以绑定多个作答位。每个作答位仍然只被一个积木绑定。
- 隔离方式（iframe 或 Worker）由界面线选定。

## 2. 作答信封（网页与 PDF 相同）

作答就是现有 ResponseSet 的条目，定义在 `src/core/schema/assessment/response.ts`：

```ts
{ slot_id, kind: 'select', state: 'answered'|'blank'|'unknown', item_ids: string[] }
{ slot_id, kind: 'blank',  state: 'answered'|'blank'|'unknown', text: string }
{ slot_id, kind: 'open',   text_md, evidence: EvidenceAttachment[] }   // free
```

- `blank` 表示学生主动留空，此时内容必须为空。`unknown` 表示拍照或作答卷上看不清，只由回收侧使用，网页不产生。没有条目表示未作答。
- 重复或不在 universe 里的 id 是协议错误，提交会被拒绝。选多、选错是有效作答，交给给分规则处理。
- 一对一配对等结构约束由槽上的 `at_most_per_coordinate` 声明，提交时校验。
- 同一道题换一种布局（例如 option_list 从 vertical 改成 grid，或断句放进 passage_layout 与否），交出的信封完全相同，判分也相同。

## 3. 发布时的绑定校验（后端，在唯一发布口 `publishQuestionGroup` 的同一道校验里）

1. 发出的 part 里，每个可作答槽恰好被一个输入积木（或自定义块的一项 bind）绑定。不漏，也不重。
2. `bind.response_class` 与槽种类一致：select↔`select`，blank↔`blank`，free↔`open_response`。
3. `bind.unit_id` 是一个计分单元，且该单元的 `slot_refs` 包含 `bind.slot_id`。
4. 输入积木种类与槽形态相容，见 1.2 表的「对槽的要求」。
5. `part_ref` / `material_ref` 都能解析；figure 材料是已核验的公开材料。
6. block_id 唯一；kind 在白名单内；`renderer_contract` 是受支持的版本。
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
