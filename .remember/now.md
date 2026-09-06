# 当前 handoff — 2026-09-06

Owner 已继续授权 AI pipeline，并依据 1e61da8d 报告扩大为全项目业务封装和测试精简。

## 当前真实状态

- 原始 the-learning-project 脏 main 保留；集成 tlp-wt-pipeline-completion，分支 codex/yuk-939-pipeline-completion。
- 远端 main 090e882c；Draft PR #1326。流水线代码 1e61da8d 完成全部命名 synthetic actual gates。
- 本次 native $0.129296、cold+correction $0.028107、durable $0.014379、semantic $0.077014；
  合计 $0.248796，在本次最多新增 $1 内。此前已知 $0.503605 + 一笔未结算 child 仍保留未知。
- Semantic 实际生成17×19=324，四个真实 validator 尝试后拒绝，只展示安全回退；
  native 1个成功子Agent、无continuation、结果回前台；correction绑定原reply且使SDKcursor失效。
- 原 cold/resume/ambient/read/proposal/cancel 证据复用。read样本输入至少降50.8%、费用至少降62.2%；
  旧基准为不完整下界，不外推全场景。
- 证据封存 docs/planning/evidence/2026-09-06-pipeline-actual.json。
- exact-head CI 的 DB2/2 三个失败均为已退休工具断言。已修，33 scoped DB通过；
  typecheck/lint/build通过。需推送最终head并等CI，不可称已合并/部署。
- 本PR两轮独立review已用完；不启动第三轮，后续兼容修复root检查真实diff和SDK源证据。

## 扩大范围实施

- Linear workspace/get/save恢复，list部分偶发传输错误；YUK-939已更新，YUK-952已创建。
- YUK-952在独立 tlp-wt-goal-owner / codex/yuk-952-goal-owner 实施。
  首版752f6ea1只是抽SQL、仍复制status/scope规则，root已要求继续深化，尚未集成或完成。
- 下一步：目标单一语义写入命令→知识合并各状态owner→录入/判分完成责任→
  AI共同规则封装→服务端产品状态+统一UI投影→跨项目测试精简。
- 测试不按数量裁剪：替换退休实现/源文本断言，保留权限、计费未知、并发、回滚、恢复与实际输出。
- UI实现前仍需精确设计原文/组件类型/文件清单批准；后端继续。

## 边界

不部署、不切生产SoT flags、不backfill或删除历史表/数据。旧mailbox/ToolOperations恢复器仍drain-only；
退休须部署后零pending证据。逐实体最终去掉过渡策略需要prod-clone验证，不能靠默认配置推断线上状态。
