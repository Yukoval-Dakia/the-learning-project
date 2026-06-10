# practice — 练习消费侧（P2a 等价承载，YUK-312）

练习旅程的消费侧：FSRS 传感器（fsrs/judge-rating）、判分评级（rating-advisor/effective-truth/
cause-context）、卷机制（paper-detail/submit/sections/adaptation/practice-read/answer-draft/
due-list/variant-rotation）、会话编排（review-session/solve-session，原 src/server/orchestrator/
{review,solve}.ts）。P2a 为零行为变化的等价平移；应然形态（流编排器 + 卷架 + 申诉重判链）见
`docs/superpowers/specs/2026-06-10-p2-practice-journey-spec.md` §2，P2c/P2d 落地。

- server/ — 上述模块本体（测试同居，命名即分区）
- api/ — 厚 route body（外壳 app/api/{review,practice,questions}/** 挂载）
- 迁移期豁免记录：review-session/solve-session 仍 import 遗留共享件
  `@/server/orchestrator/json-sanitize`（如有），P4 清账；capability 暂可 import @/db/*。
- 包外主要消费方：proposals/actions（fsrs）、events/queries + cause-policy（effective-truth）、
  boss handlers quiz_verify/source_verify（fsrs）、copilot solve-skill（solve-session）、
  UI practice 页 + PaperCard（practice-read/paper-detail）。
