# practice — 练习消费侧（P2a 等价承载，YUK-312）

练习旅程的消费侧：FSRS 传感器（fsrs/judge-rating）、判分评级（rating-advisor/cause-context）、
卷机制（paper-detail/paper-submit/paper-sections/paper-adaptation/practice-read/answer-draft/
due-list/variant-rotation）、会话编排（review-session/solve-session）。应然形态（流编排器 + 卷架 +
申诉重判链）要点（源：
`/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/archive/superpowers/specs/2026-06-10-p2-practice-journey-spec.md` §2）：
**流** =「AI 维护的日程」（物化 `practice_stream_item`，支持白天动态插拔），**卷** =「内容打包
形态」（唯一容器 tool_quiz，卷架为持久归宿），due-list 只是 composer 的输入信号、不构成用户面
队列；**申诉（D15）** = 请 AI 带用户理由重判，改判**直接生效**（软判断层、无 proposal）+
correction 留痕 + FSRS 重投影（申诉流程详见 `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/modules/quiz.md` §8）。

- <owner>/ — 子 owner 目录（grading、settlement、question-bank、failure-learning、session、scheduling、
  supply、placement），各有 public.ts（本 owner 的稳定入口）与 manifest-part.ts（由根 manifest.ts
  组合）（`/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/design/2026-11-03-practice-split.md`）
- 根目录是练习面：组合文件（manifest.ts、public.ts、ui-public.ts、task-public.ts、tasks/index.ts）、
  解题辅导/提示会话（server/solve-*、tutor-session、hint-explanation 与 api/solve-*）、练习 UI（ui/）。
  另有待落位余项：供题生成（server/ 的 supply-plan-operation、web-sourcing-operation、quiz/，
  jobs/ 的 quiz_gen*、supply_planner，tasks/ 的 sourcing/supply-planning 等）；
  归属按 scripts/audit-practice-subowners.ts 的 supply 映射计，功能线落位到 supply/。
- api/ — route body，由 manifest 的 load thunk 懒加载挂到 server/app.ts
- 迁移期豁免：capability 暂可 import @/db/*
- 包外主要消费方：src/server/questions/*（提交与去重）、proposal undo-guard、判分/orphan
  durable worker、admin 配置事实；web 与 server/start 经 ui-public 取客户端类型。
