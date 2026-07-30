# 当前 handoff — 2026-07-30

## Active line

- 唯一 active lane：**YUK-827 Probe 响应签名可诊断性**。
- branch：`codex/yuk-827-response-signature`。
- 隔离 worktree：`the-learning-project-worktrees/yuk-827-response-signature`。
- 基线：`origin/main@09ac0f21`，已包含 YUK-796 / PR #1117。
- owner 主工作树有既存未提交改动；本轮没有修改主工作树。
- 完整 gate 只监听 GitHub Actions `CI Gate`，不在本地重跑。

## 本轮实现

1. `ConjectureProbePackageV2` 不规定必须二元选择，支持：
   `single_choice`、`multiple_select`、`short_answer`、
   `answer_with_reason`、`constructed_response`。
2. 每道题必须有可区分的 gold 与 target-error response signature；裸单选若正确理解与
   目标误区会落到同一响应、或只能随机猜测，结构门直接拒绝。
3. 新 proposal 只能写 V2 + audit v3；历史 V1/V2 仍可读，混合版本拒绝。
4. QuestionAuthor/Reviewer 明确检查实际题面、独立求解、multi-select 集合、表示变化与
   tested claim；最多两次整包生成，失败后 abstain。
5. immutable `probe_spec` 随 question snapshot 持久化；V2 快照缺失、被编辑或版本漂移，
   在付费 Judge 前 409 fail closed。
6. `MultimodalDirectJudgeTask` 同一次调用同时输出 `answer_result` 和
   `gold | target_error | neither | ambiguous`；普通答错不等价于命中目标误区。
7. lifecycle 持久化/replay response judgement；旧事件无 judgement 时返回明确降级原因。
8. migration `0084_yuk827_response_signature_cutover.sql` 退休迁移前 pending 的 agent
   conjecture，不改写 owner dismissal。暂停的 YUK-791 分支合并前必须 rebase 并重新编号
   其冲突的 `0084`。
9. typed client、API response、grounding artifact、prompt audit snapshot 与相关 fixtures
   已同步。

## 验证证据

- 固定 8 个 mock 输入，模型输出不 mock；继续复用真实 production orchestration、
  prompts、parsers。
- 最终选择结果：
  - grounded proposal：7/8（87.5%）
  - serious factual error：0
  - claim/probe mismatch：0
  - operational error：0
  - chain case：三次调用无语义共识，安全 `abstain`
- 当前代码重新解析 7 个入选 proposal：7/7 PASS。
- targeted unit：9 files / 273 tests PASS。
- targeted DB：6 files / 103 tests PASS。
- YUK-827 migration smoke：1 PASS / 28 skipped。
- `pnpm typecheck` PASS。
- prompt audit：12 snapshots CLEAN。
- API client 与 Postman collection 已重新生成。

## 边界

- YUK-827 development gate 已过，但这不是 YUK-814 的真实 owner 发布 gate。
- YUK-814 Gate A/B/C 仍开放；auto-intervention expansion 保持 OFF。
- YUK-822 是 P1，owner 明确本轮只保留解释和计划，不写实现。
- canonical Opus 的 429 只记 operational；开发 gate 使用与旧基线一致的
  supported Xiaomi/Mimo fallback。

## 下一步

1. commit/push，创建 ready PR。
2. 仅监听 exact-head GitHub Actions `CI Gate`；处理 review thread 后 squash merge。
3. merge 后把 YUK-827 更新为 Done。
4. 恢复 YUK-791；先 rebase/renumber migration，再继续 intervention 准备链。
