# 当前 handoff — 2026-07-30

## Active line

- 唯一 active lane：**YUK-791 干预准备通电**。
- branch：`codex/yuk-791-intervention-prepare`。
- 隔离 worktree：`the-learning-project-worktrees/yuk-791-intervention-prepare`。
- 基线：`origin/main@abc62490`，已包含 YUK-827 / PR #1118。
- owner 主工作树有既存未提交改动；本轮没有修改主工作树。
- 完整 gate 只监听 GitHub Actions `CI Gate`，不在本地重跑。

## 本轮实现

1. 新增 Agency-owned、versioned `intervention` aggregate，冻结 snapshot、推荐、整包、
   两轮审计、terminal failure 与 delivery mode；进入 backup/restore 并有 migration smoke。
2. durable probe-result subscriber 只接受 `evidence_for + outcome=0` 且 response judgement
   明确为 gradable target-error match；再验证 proposal/question/result direct chain 仍有效。
3. 被纠正结果、legacy 无 judgement、普通错误或 question/provenance 漂移均不 enqueue。
4. subscriber 与 pg-boss enqueue 共事务，使用确定性 aggregate identity + 持久 UUID job id；
   重复 id 返回 null 视为已有 job，重复 delivery 不产生第二个 aggregate。
5. Agency 用冻结 learner/KC/conjecture snapshot 调用确定性 8 法 shortlist；owner 禁用后无
   安全方法时不调用模型，直接 `recommendation:no_safe_method` fail closed。
6. recommendation 在同一 `prepare_intervention` wave 交给 Practice QuestionAuthor；后者公共
   输入只有 `intervention_id`，经 Agency public reader 取得权威 snapshot/recommendation。
7. 每个 package 原子包含材料、immediate/delayed/transfer；三题复用 response-aware Probe
   V2，支持多种响应形式且必须有可区分的 gold/target-error signature。
8. author 与 reviewer 是同模型路由的两次独立调用；确定性 validator 再检查 lineage、
   method、claim、target error、重复题面、答案泄露和 response signature collision。
9. 最多一次整包重生成；两次仍失败写 `preparation_failed`，package 保持 null；通过才
   原子 `active` 并写 lifecycle event。provider/transport error 抛给 pg-boss retry。
10. `AUTO_INTERVENTION_EXPANSION_ENABLED` 默认 OFF；当前 aggregate 可 active 但
    `delivery_mode=shadow`，不代表 Today/B3 可以交付。
11. 任何付费调用前先验证 source direct chain，激活事务再验一次；enqueue 后或生成期间
    证据被纠正/provenance 漂移会原子写 `source_evidence_inactive`。
12. backup 保留 aggregate 但不保留 pg-boss 行；restore 会清掉 archived job id，避免同库
    残留的旧 terminal 行被误判成当前 retry exhaustion。两分钟 recovery 为 missing job
    换新 UUID 并同事务持久化；它与 subscription replay 共用 source lock，持锁后再查
    liveness，避免并发生成两个付费 wave。当前 job 耗尽 retry 才转为可审计失败。
13. recommendation/author/review（含 author 内层 response signature）都使用无 `anyOf`
    的扁平 provider schema，canonical reader 仍严格校验分支；三次生产调用都显式传
    registry-derived `outputFormat`。共享 canonical JSON SHA-256 消除 digest 键序漂移。
14. intervention 的两个 event provenance 建硬 FK，active CHECK 关闭 SQL NULL 三值漏洞；
    review 缺 run id 作为整包 attempt failure 重试，idempotent terminal replay 记 idle。

## 验证证据

- targeted unit：8 files / 153 tests PASS。
- targeted DB：2 files / 15 tests PASS，新增覆盖付费前/生成期间 evidence 失效、跨库/同库 restore
  job recovery、operational retry exhaustion、review run provenance 缺失。
- YUK-791 migration smoke：1 PASS / 29 skipped。
- `pnpm typecheck` PASS。
- scoped Biome PASS；capability boundary audit 0。
- schema audit：unallowed stub 0；`intervention.outcome` 明确 allowlist 到 YUK-792。
- flag audit：本 lane 的 reader marker/ledger 无 drift；全仓 strict 模式仍有基线已有的
  `NOTES_MASTERY_SUBSCRIPTION_ENABLED` 未登记警告，不属于本 lane 行为改动。

## 边界

- YUK-791 是 shadow preparation backbone，不关闭 YUK-814 发布/扩量 gate。
- YUK-814 Gate A/B/C 仍开放；auto-intervention expansion 保持 OFF。
- YUK-822 是 P1，owner 明确只保留解释和计划，不写实现。
- YUK-792 scheduler/settlement、Today/Brief UI、Copilot、Growth projection 不在本 PR。

## 下一步

1. 将 PR #1119 的集中 review hardening commit + push。
2. 仅监听新 head 的 GitHub Actions `CI Gate`，回复/resolve review threads 并复查新增反馈。
3. CI/review 全绿后 squash merge并对齐 Linear YUK-791。
