# 票号与 PR 关联

仓库文档不做追踪：任务、归属、进度、阻塞和票号历史不写进 `AGENTS.md`、`docs/`、`README.md` 或 nested `AGENTS.md`。本文件只留 git 侧仍生效的票号写法。

## 写法

- branch 名用 `yuk-NN-<slug>`（带 issue id）。
- commit message 至少一条带 `Closes YUK-NN`、`Fixes YUK-NN` 或 `Part of YUK-NN`；一个 commit/PR 涉多票时每票单起一行：

  ```text
  Closes YUK-27
  Closes YUK-28
  ```

  不写 `Closes YUK-27 + YUK-28` / `Fixes YUK-27, YUK-28` / `Part of YUK-27 and YUK-28`——关联只认第一票。
- 新工作用 `YUK-NN`，不用裸 `#N`；`#N` 只用于历史 GitHub issue 考古。
- PR 标题和正文带同一个 `YUK-NN`。

## 收尾

发现的 follow-up 交 lead 登记到仓库外任务面。已验证的可执行 follow-up 不留在最终回复/TODO/scratch 里当唯一记录，也不写进文档清单。

## 不做

- 不在文档里记 issue 状态、进度、归属、cycle、标签或 closeout 清单。
- 不提交 `PLAN.md` / `.remember/now.md`（worktree 私有）。
- 不做 tracker → git 反向同步（改状态不触发建分支/checkout）。
