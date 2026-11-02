# 下一 DBOS 族：review 会话清理候选

状态：只读调查与父级调用链核对完成，尚未实施。基线main `f80d47703`。1392仍是唯一代码writer；其释放后再确定家族和共享生命周期文件的写入权。1355、1358、1359均未完成。

## 候选与实际职责

推荐继续设计 `prune_orphan_review_sessions`：`src/server/boss/handlers.ts` 的infra cron每天04:15 Asia/Shanghai触发，`handlers/prune_orphan_review_sessions.ts`查询超过六小时的started/paused review会话，调用既有 `Review.abandonReviewSession`。`src/server/session/review.ts`锁行后在同一事务中写状态、version和job event。无provider/blob调用；仍由pg-boss恢复。

相比之下，`subject_profile_audit_nightly`只是只读检查；`ai_task_run_reconcile_nightly`还与worker boot sweep和未知费用结果处理交叠，不作为首选。现有历史68族静态清单不是运行中义务数；53 manifest handlers、18 schedule和infra/memory注册范围不可混为同一数量。

## 必须先解决的语义

- 原sweep内部每次调用Date.now，重放不能重新扩大同一tick的时间范围。先明确固定tick输入和恢复身份。
- 原select与状态转换分离；reopen会重置started_at。必须在事务锁内重核资格，证明并发reopen不会被旧选择误关闭；不能复制Review状态机或把普通状态重读称为exactly-once。
- 原handler吞掉逐行异常并依赖后续cron；保留与明确部分完成和失败证据，不能将不明事务结果写成成功。是否需要receipt须基于最终重放合同裁决，当前不预设。
- `register-capability-jobs.ts`只准入prune_job_events，`durable/prune-worker.ts`只注册该族并独占DBOS.launch。第二族必须共用唯一lifecycle，不能另起SDK owner或复用prune专用phase行冒充多族控制。

Start集成线程5796已确认上述固定tick、锁内资格与reopen验收要求；1392释放后协调共享注册与boot文件，当前不碰Start/shared boot。候选涉及infra registrar、家族durable模块、phase/fence迁移和操作入口；准确文件清单尚待设计定界，不是实施授权清单。

## 退出验收

在独立合成数据库和进程中验证旧worker/延迟cron插入fence、单恢复owner、epoch等待、部分行已提交而checkpoint未写的崩溃恢复、并发关闭/reopen、重复tick、未知事务结果、实际cron/timezone和rollback窗口。业务状态和job event不得重复，未处理行不得丢失。最终删除旧族注册必须先排空并分类全部旧义务；源码清单或schedule行不足以证明退出。

调查来源为T3只读任务 `yuk1359-next-dbos-family-readonly-20261009-v1`（Codex gpt-6-luna high，completed/noPending）；父另实读上述handler、Review转换与DBOS lifecycle。无DB、测试、服务、provider或部署运行。跟踪沿既有1355 comment `75be48f8-c41f-4911-ad14-ee65a1d1e179`，不重复建票。
