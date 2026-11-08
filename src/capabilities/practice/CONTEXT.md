# practice — 练习消费侧（P2a 等价承载，YUK-312）

练习旅程的消费侧：FSRS 传感器（fsrs/judge-rating）、判分评级（rating-advisor/effective-truth/
cause-context）、卷机制（paper-detail/submit/sections/adaptation/practice-read/answer-draft/
due-list/variant-rotation）、会话编排（review-session/solve-session，原 src/server/orchestrator/
{review,solve}.ts）。P2a 为零行为变化的等价平移；应然形态（流编排器 + 卷架 + 申诉重判链）要点（源：
`/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/archive/superpowers/specs/2026-06-10-p2-practice-journey-spec.md` §2，YUK-1575 重立档）：
**流** =「AI 维护的日程」（物化 `practice_stream_item`，支持白天动态插拔），**卷** =「内容打包
形态」（唯一容器 tool_quiz，卷架为持久归宿），due-list 只是 composer 的输入信号、不构成用户面
队列；**申诉（D15）** = 请 AI 带用户理由重判，改判**直接生效**（软判断层、无 proposal）+
correction 留痕 + FSRS 重投影（申诉流程详见 `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/modules/quiz.md` §8）。

- <owner>/ — 子 owner 目录（grading、settlement、question-bank、failure-learning、session、scheduling、
  supply、placement），各有 public.ts（本 owner 的稳定入口）与 manifest-part.ts（由根 manifest.ts
  组合）（`/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/design/2026-11-03-practice-split.md`）
- 根目录是练习面：组合文件（manifest.ts、public.ts、ui-public.ts、task-public.ts、tasks/index.ts）、
  解题辅导/提示会话（server/solve-*、tutor-session、hint-explanation 与 api/solve-*）、旧练习 UI（ui/）。
  另有一类待落位余项：供题生成（功能线落位到 supply/）；
  它们的归属由 scripts/audit-practice-subowners.ts 的映射计
- api/ — route body，由 manifest 的 load thunk 懒加载挂到 server/app.ts
- 迁移期豁免记录：capability 暂可 import @/db/*。原 solve-session 的
  `@/server/orchestrator/json-sanitize` 豁免已清账——共享件 YUK-1570 迁入
  `@/core/json-sanitize`，solve-session 现从 core 引用。
- 包外主要消费方：proposals/actions（fsrs）、events/queries + cause-policy（effective-truth）、
  boss handlers quiz_verify/source_verify（fsrs）、
  UI practice 页 + PaperCard（practice-read/paper-detail）。
