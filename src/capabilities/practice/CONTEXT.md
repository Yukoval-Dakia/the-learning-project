# practice — 练习消费侧（P2a 等价承载，YUK-312）

练习旅程的消费侧：FSRS 传感器（fsrs/judge-rating）、判分评级（rating-advisor/effective-truth/
cause-context）、卷机制（paper-detail/submit/sections/adaptation/practice-read/answer-draft/
due-list/variant-rotation）、会话编排（review-session/solve-session，原 src/server/orchestrator/
{review,solve}.ts）。P2a 为零行为变化的等价平移；应然形态（流编排器 + 卷架 + 申诉重判链）要点（源：
`docs/archive/superpowers/specs/2026-06-10-p2-practice-journey-spec.md` §2，YUK-1575 重立档）：
**流** =「AI 维护的日程」（物化 `practice_stream_item`，支持白天动态插拔），**卷** =「内容打包
形态」（唯一容器 tool_quiz，卷架为持久归宿），due-list 只是 composer 的输入信号、不构成用户面
队列；**申诉（D15）** = 请 AI 带用户理由重判，改判**直接生效**（软判断层、无 proposal）+
correction 留痕 + FSRS 重投影（申诉流程详见 docs/modules/quiz.md §8）。

- server/ — 上述模块本体（测试同居，命名即分区）
- api/ — 厚 route body（外壳 app/api/{review,practice,questions}/** 挂载）
- 迁移期豁免记录：capability 暂可 import @/db/*。原 solve-session 的
  `@/server/orchestrator/json-sanitize` 豁免已清账——共享件 YUK-1570 迁入
  `@/core/json-sanitize`，solve-session 现从 core 引用。
- 包外主要消费方：proposals/actions（fsrs）、events/queries + cause-policy（effective-truth）、
  boss handlers quiz_verify/source_verify（fsrs）、copilot solve-skill（solve-session）、
  UI practice 页 + PaperCard（practice-read/paper-detail）。
