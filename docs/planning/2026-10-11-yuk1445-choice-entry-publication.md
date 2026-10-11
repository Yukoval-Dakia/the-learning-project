# 一题选择题从真实入口到提交判分

此片沿已合 ADR-0073/0074，接在 PR1677 的 serving gate 后。功能线唯一源码树为 `tlp-yuk-1445-choice-entry-publication`，base `79825bb6d`。迁移已释放本片的 assessment publish/structure/DTO、StructuredQuestion 与 practice task index；不触及 DDL、job、Start、boot、DBOS、shared control 或 calibration-sample core。

## 行为

触发为现有 `store_sourced_question` 提交一个完整、无图、印刷分值明确的单选候选，并声明 `choice_entry: { printed_points }`。不新增工具或写入口。现有 jyeoo/web 的来源校验、活体知识节点、exact/near 去重和 source_verify 链继续使用。

入口在事务外通过中央产品 runner 调用两次 `ChoiceEntrySolveTask`。两次只有题干、稳定 option ID 与选项、显式印刷分值、part/slot/unit 身份；没有来源参考答案、学生作答、另一 solver 输出或会话回放。第二次只反转显示顺序，稳定 ID 不变。每次必须有成功的真实 ai_task_runs 记录；不一致、无法完成或非法 ID 时不发布，不用文本解析救回结果。使用现有产品 provider binding，不另加 credential 或改模型路由。

AI 产出的 `option_set_key` 存在既有 question.structured 的 typed assessment 字段；每个选项带 option_id。normalizer 优先消费这个字段，不读取参考答案铸键。AI 的完整解答只成为私有 reference 材料。印刷分值由捕获方明确提供，本片不推断或发明总分；其余题型不由这片自动准入。

在执行标定前，机械生成并冻结完整探针集：每个选项单独选择、反转显示顺序下正确 ID、显式空白。期望结果由 typed key 机械核验。所有探针走实际提交使用的同一个 evaluateSubmissionCore，模型调用数必须为零。证据保存两个 task-run、实际 provider/model、请求/输出 digest、完整冻结 revision digest、题面 digest、方法版本/指纹、事先冻结的 probe digest 与逐条结果。全部通过才准入；不是模型级 judge 准入，也不是所有题库覆盖率的证明。

题目仍由 insertSourcedDraft 与 canonical publisher 同事务写入。入口结构在第一次发布前已完整，不先制造一个启发式键再覆写。标定证据扩展既有 admission evidence，并追加到 question_admission_verification；无第二套存储。正常 source_verify 的 solve_check 读回校验当前冻结 revision、双 task receipt 与完整标定，使用稳定 ID，不再经 legacy 文本解答比较。它对相同冻结内容保留入口 proof 和 system_verified 标记，不把 AI 解答标作 official。题面/答案或方法变化时旧 proof 不能借用；旧 revision、issuance、submission、judgment 不改。

## 无答案键的展示合同

`structure.presentation` 随既有 revision 与 integrity_digest 冻结。v1 的积木只有引用：

```ts
{
  version: 1,
  layout: 'stack' | 'passage_split',
  blocks: (
    | { kind: 'prompt', part_id: string }
    | { kind: 'material', material_id: string }
    | { kind: 'response', slot_id: string, scoring_unit_id: string }
  )[]
}
```

每个作答位必须绑定被相应评分单元消费的槽位，题面/作答位不得漏掉。引用私有材料、悬空绑定或重复作答位拒绝发布。strict schema 不接受答案键、任意 props、HTML 或 JS。PracticeIssuanceDto 只投影发出 part 范围内的这些引用，材料仍受公开/私有边界过滤，选项仍按 issuance 的冻结顺序读回。UI 积木渲染由 Opus 交付，不是此片的前置条件。

## 验证与当前限制

本地只做五类不变量内的确定性评分、隐私和不可变发布验证，加 typecheck/lint/build。AI 实际输出另封任务、输入输出、provider/model、费用与 revision；mock 不作质量证据。旧 serving CI 红日志不覆盖。

真实产品验收必须完成同一候选的入口双解、冻结标定、正常 source_verify、canonical 发布、公开 issuance/spec 读回、真实 saveSubmission/evaluateSubmission。选择正确稳定 ID 得印刷满分，其他 ID 得零；反转显示顺序不改变结果。只产 JSON、成功 enqueue 或绿色单测不算贯通。

当前首片仅消费已有 jyeoo/web 候选合同，仍需一个 live KC，不能宣称已完成 question-only photo/owner_material 通用录入。非 fetch 来源泛化、KC proposals、任意题型和纸面作答回收沿原路线后续接入同一个提交门，不伪装来源 URL 或假造 fetch hash。新的 UI 和迁移消费者只读取审查通过的固定 revision。

运行前必须协调并原子取得共享 deployment lock；TEST 数据不写，现场登记的 TEST 与 loft 服务逐项 parity，不能假定只有四个运行服务。新的 paid acceptance 仍走既有 aggregate ledger 与 transport-03，每次物理调用事前 reserve，未知费用不记零。当前文档与源码不代表已经运行 provider、完成 TEST 部署或通用模型准入。
