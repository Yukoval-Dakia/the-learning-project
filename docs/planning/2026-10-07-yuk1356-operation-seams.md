# YUK-1356：共享复习操作的消费者调查

2026-10-07，基于 `8eb10cb8a` 的只读调查。此文是实施输入，不是迁移完成证据。主线线程负责独立工作树和唯一实施 writer；本线程负责接口调查与 YUK-1364 收口。

## 保留现有真相源

`practice/server/assessment/submit.ts:saveSubmission` 已拥有原件、发题坐标、幂等键冲突、学习范围快照和草稿删除事务。`assessment/attempt.ts:commitFormalAttempt` 是同步提交和后台执行共同使用的评分激活链。继续复用这些操作，不把 YUK-1338 测试用表带入产品。

`api/submit.ts:createAttempt` 当前混合 HTTP 解析、诊断题准入与 claim、持久派发、正式提交和响应映射。拟提取 `submitReviewAnswer(database, input, context)`；成功区分 pending 与 committed，既有准入拒绝、坐标/版本冲突、取消和失败语义同样必须保留。不得用成功结果联合吞掉错误。

## 消费者与所有权

| 入口 | 当前证据 | 迁移边界 |
| --- | --- | --- |
| HTTP | `api/submit.ts`、`api/review-sessions.ts` | YUK-1352 负责鉴权、解析、响应；YUK-1356 负责业务操作 |
| 后台 | `jobs/judge_run.ts` 调 `executeNativeAttempt`，并反向 import `api/submit` 的 claim release | YUK-1356 将 claim release 移至领域模块；YUK-1355 负责派发和唯一恢复机制 |
| Pi | practice manifest 注册 `get_review_due` 等读取/创作工具，当前没有提交复习答案工具 | 需薄 DomainTool、显式授权范围及可信原件来源；不得把模型生成答案记为用户独立作答 |
| 下一安排 | `server/due-list.ts:handleReviewDue` 仍接受 Request 并返回 Response | 提取 typed query，保留 FSRS、跨科目排序和目标软排序；不新建第二套选择器 |
| Solve tutor | `server/solve-session.ts` 用 `commitFormalAttempt`，带 Tutor 状态与错题记录回调 | 保留专属语义，不强制改成 solo 操作 |

复习 session 继续使用 `src/server/session/review.ts` 的既有生命周期操作。原子提交和后台重放不能绕过冻结原件或重复应用学习效果。

## 必须取得的验收证据

- 页面命令、Pi adapter、后台执行使用同一业务契约，拒绝、冲突和取消语义一致。
- 较晚评分不能覆盖较新的学习证据；相同原件重放不重复写学习效果。
- 模型不可用时，确定性评分、显式记录、FSRS 和下一安排仍可工作。
- DBOS 与旧 pending reconcile 只有一个恢复所有者；未知外部执行结果不得盲目重试。
- 实施 diff 明确列出被替换的重复路径及删除条件；真实业务表测试通过后，再完成独立审查、exact-head CI 和测试部署验收。

工具索引在本工作树未就绪（health 无 generation/chunks）；本调查交叉读取了实际 manifest、函数及调用点，没有触发付费索引构建。
