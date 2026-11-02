# YUK-1356 真实 Pi 提交验收

准确候选 `4cccb1a628` 的 CI Gate 37768767757 全绿，R2 独立审查 NONE。2026-10-08 11:28Z，父在线执行一次真实 `opencode-go/mimo-v2.6-pro` Copilot/Pi 调用，模型通过已注册 `submit_review_answer` 提交鉴权请求捕获的合成学习者原件；未替换模型/工具返回。既有执行 owner 负责绑定、取消及收尾，runner seam 仅将工具范围约束为本工具、两 turn/90 秒并禁自动重试。

实际出现一个 root task、一次领域工具 committed、一条完成的确定性 evaluation 和一次 activation。原件响应和冻结坐标不变；帮助程度 unknown，mastery/FSRS 均零。token、缺失授权、无绑定及过期拒绝已在付费前验证。估算费用 $0.002818771，来源 Pi catalog；不是供应商账单证明，provider_attempt 行为零。

## 保留的失败与父裁决

前三次本地准备分别暴露 PATH 缺 Docker、pg-boss schema 初始化缺 reserved connection、新库仍为 legacy epoch；均 root_invocations=0、没有模型提交。各次独立证据保留，最终使用正常 epoch transition 和新独立 PG。没有删除失败记录来刷绿。

真实模型及全部效果断言通过后，脚本在 HTTP 重放状态断言失败：预期写成200，实际为201。父读取 `createAttemptResource`，确认既有 canonical created 接口明确返回201；再独立比较 after-provider 与 cleanup 前 final 的全部19类关系，完全一致，证明重放没有新增效果。执行 owner/原件 receipt 重放均已执行。原失败 terminal 保留，父将本次有限行为验收判为通过，不再次调用模型，也不将脚本exit1称为exit0。

## 运行边界

真实 Hono app.request 使用产品token/epoch与业务链，未测TCP/浏览器和后台worker取件。新chat原件保守assisted；合成出版准入不代表真实题目质量。仅该领域工具开放，不代表整套Copilot工具面验收。DBOS评分族、Start提交消费者和部署仍待1356/1358推进。

11:29:22Z核owner后释放运行锁；临时PG退出，主四容器ID/image/start/health及release SHA完全一致。未部署、未重放主队列，用途保持Agent TEST ONLY。完整输入/输出/SQL保留在本机隔离证据目录；版本化[证据索引](2026-10-08-yuk1356-real-pi-acceptance.evidence.json)含23文件hash、模型/任务/费用、失败和父裁决。无新增产品缺陷需建票；剩余迁移范围仍归既有YUK1356/1358/1359，不能因PR合并关闭父票。

## 最新 main 集成边界

真实调用后正常合入 main4a3d（1596 Copilot数量预算/远程工具结束与finalization，以及1607事件领域）。仅PLAN/remember人工冲突；产品自动合并后父检查原件绑定改动和main改动同时保留，139unit、110DB、typecheck/lint/build通过，主服务/release不变。详细[集成证据](2026-10-08-yuk1356-main4a3d-integration.evidence.json)保留文件交集与日志hash。没有重复付费调用；原真实输出严格绑定4cccb，不称新整合源码、无约束Copilot全部行为或部署已经真实验收。本PR的新增可信原件提交行为已有真实输出，main交互另由集成回归覆盖。
