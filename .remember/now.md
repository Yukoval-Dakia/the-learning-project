# 当前 handoff — 2026-07-30

## Active line

- 唯一 active lane：**YUK-796 教学法审议设计**。
- 隔离 worktree：`yuk-796-pedagogy-design`。
- branch：`codex/yuk-796-pedagogy-design`。
- owner 主工作树有既存未提交改动；本轮未修改主工作树。
- YUK-821 / PR #1114 已 squash merge，merge commit `f3159ae5`。
- 完整 gate 只监听 GitHub Actions `CI Gate`，不在本地重跑。

## 选定设计

1. 不建独立 Planning Panel；控制区进入 Teaching Brief projection。
2. Agency 是 recommendation/intervention/verification lifecycle 的唯一写入者。
3. public command 只接 `intervention_id + idempotency_key`；禁止 raw context。
4. 复用现有 8 法 palette/policy 作为 deterministic legal shortlist。
5. 单次 recommendation task 只能在 shortlist 内选择或 abstain。
6. recommendation 在同一 `prepare_intervention` wave 被 YUK-791 intervention-scoped
   QuestionAuthor 消费，不能单独落成 dead rail。
7. 同模型第二次独立自审 + deterministic checks；整包最多重生成一次，之后 fail closed。
8. 无新 agent seat，不恢复 planner/critic/judge fan-out。
9. 自动激活；owner 可 cancel/reprepare，reprepare 新建 version 不覆盖历史。

设计文档：
`docs/design/2026-07-30-yuk-796-pedagogy-deliberation.md`。

## P0 与发布现实

- 固定 8-case mock-input / real-output 从 6/8 改善到 7/8，按 owner 口径允许继续开发。
- YUK-827 保留唯一 expected-target response 不可判定 P0 tail；不声称绝对 5/5。
- YUK-814 严格 Gate A、real-observation Gate B、canary Gate C 仍未全部通过。
- auto-intervention expansion 必须保持 OFF；真实数据不再阻塞开发。

## 下一步

1. 提交 design + ADR + source truth-comment + cockpit 同一 batch。
2. 开 PR，只监听 GitHub CI Gate；处理 review 并 merge。
3. YUK-796 Done 后启动 YUK-791 implementation lane：先 contracts/persistence，再
   recommendation、intervention-scoped QuestionAuthor，最后 UI pre-flight。
