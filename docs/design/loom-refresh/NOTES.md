# loom-refresh 设计稿 bundle（2026-06-10 入库）

claude.ai/design 的 handoff bundle（share: `hZsrpf3JJ2hSIDmXnjYnDw`），**全应用视觉基准**——M2 练习流起逐 M 取稿。

- `chats/` — 8 轮设计对话 transcript（意图所在，读这个优先于读源码）。
  chat7 = 练习面（按 2026-06-10 流 UI 功能 handoff 建成，§6 四开放题的设计答案在此）；
  chat8 = 最新全局审查（⌘K 命令面板）；chat1 = round-1/2a/2b/NoteReader/P5 演进。
- `project/` — 原型源（HTML/CSS/JSX，React UMD + babel standalone 形态）。
  **M2 用 `pface-*.jsx` + `screen-pface.jsx` + `pface.css` + `data-pface.jsx`**；
  `screen-practice.jsx`（chat2 旧练习卷首页）已被 pface 取代，落地忽略。
  这是设计稿不是生产代码——落地时按既有 tokens/primitives 重写，匹配视觉输出而非复制内部结构。

裁剪声明：原 bundle 21MB；入库仅保留文本源（chats + project 顶层 jsx/css/html/js + loom-mark.svg），
剔除 fonts/ screenshots/ uploads/ _ref/ 等二进制参考物。完整原包在本机 `.omc/design-handoff/`
（gitignored）与 claude design share 链接处各有一份。
