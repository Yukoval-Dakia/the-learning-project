# 完整重构完成契约

Owner目标：agent现代高效、能力配合AI-driven学习框架、产品可扩展、代码可读。
这是持续目标，不因单一PR、测试减少或依赖计数变小而完成。核对基线：main9427202c。

## 必须逐项证明

| 要求 | 完成证据 | 当前缺口 |
|---|---|---|
| 低上下文成本 | 同输入实际provider输出质量、token/cost、未知费用账本；规则有单一权威 | 944重复规则、946技能暴露、945长会话compact |
| 现代agent交互 | 同会话resume/compact/steer，native child回到父轮；普通chat与显式Mission职责清楚 | 945/948/950；已有native成功不覆盖其余 |
| 成品与产品状态 | 前后台/replay一致、成品来自实际产出，失败不会假成功 | 958完成；949仍依赖模型HTML尾标 |
| 学习闭环 | 学习意图、录入、判分、复习、提议/接受/撤回的复杂成功/失败/并发恢复场景 | 需集成复核已有owner收口，不由单模块测试推断全产品 |
| 扩展与可读性 | 添加学科/工具/判分能力只触对应owner与组合声明；变更三类业务行为无需复制状态规则 | 仍有5capability SCC/20命令消费者，需要逐边验证责任而非登记豁免 |
| 单一状态实现 | 每实体真相源与回放一致，兼容分支明确退出证据 | 生产SoT证据/开关/历史退休未授权，不能猜测或伪称完成 |
| 高价值验证 | 公共行为、权限、费用、并发/恢复、真实模型输出、生产bundle浏览器与exact CI | 逐项沿变更替换内部重复断言；不按数量删除 |

AI-driven框架对齐以v0.3框架文档的共享SubjectProfile、统一Judge/Proposal/owner-service、
可追踪可逆学习闭环为约束；其明确Later/HOLD的新平台/产品功能不是擅自扩张授权。
若当前设计与代码不符，需要以现有consumer和owner锁定决策重新判定，不能照抄过期roadmap。

## 当前实施：YUK-944

- 保留已有typed reader输出/分页/关系/权限和学习内容校验；完整claim边界不再被三份自然语言抄写。
- TaskSpec保留短的deny-by-default使用规则和字段导航；SKILL只留工作方法；query_events保留选择与参数语义。
- 真实验收须覆盖空窗口、跨subject因果、未观测队列/生命周期、redaction与已知正事实；既不造否定，也不把所有问题推成无法裁决。
- 计量prompt/body/description成本，并在剩余已授权费用内做有界actual；未知成本立即停新增付费调用。
- 本轮不启用YUK832 HOLD、不添加通用harness/第二套skill系统、不部署/修改生产数据。

后续顺序与状态在PLAN/Linear维护；结束一个切片只记录进展，完整goal继续active。

### Reader v2：事件可用性不等于作答活动支持

四次完整actual暴露了表示层歧义：存在且返回typed evidence的conjecture/probe被标为
`unsupported_event`；`coverage.complete`则被模型扩张为整条链或孙代覆盖。
这是确定的接口歧义，但修正能否充分改善模型质量仍须同一五读取actual证明。

- `reader_version=2`；lookup仅说明found/not_found/inactive，不再将“非作答活动”写成查证失败。
- `answer_activity_status`独立说明available/not_applicable/unavailable；未知或无效作答不伪造attempt。
- inactive先于非作答分支判定，保留撤回/替代身份和原payload/redaction保护。
- 因果coverage携带`focal_event_id`、`scope=focal_event_direct_children_only`、`descendant_subtrees=not_observed`。
- `observed_edges`仅由已返回且caused_by匹配的parent→focal、focal→child生成；`different_subject_ids`
  由两端事件对象ID确定性计算（任一未知则null），不把同起因或同学科当作同一事件对象。
- 保持原工具/输入名、查询次数、源事实、兼容空字段及MCP适配层；不新增工具或第二套证据处理系统。
- 原actual证据不改写；新版夹具仅迁移上述合同元数据，原查询参数和事件事实不变。
