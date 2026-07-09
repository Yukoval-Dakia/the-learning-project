# 文言文阅读理解题组评分细则

供质检 `kind_conformance` / `material_grounding` 检查与未来 judge 判分共用。

## 一、题组合格性细则（kind_conformance）

一组阅读题**合格**当且仅当：

1. 有一份真实文言原文作锚，并以 material_grounded 持久化（顶层 `material.body_md` 非空）。
2. 小题数 3–5，至少含一道**内容概括/分析题** + 一道**实词解释题**，各小题考点不重复。
3. 客观小题均为 `choice` + `exact`，给 4 个选项，`reference_md` 标明正确项 + 原文依据。
4. 每道小题的答案依据都能在 `material` 原文中定位（否则 material_grounding fail）。
5. 选项有真实区分度，错误项设在常见陷阱上（张冠李戴 / 时空错位 / 因果倒置 / 无中生有）。

## 二、单题判分细则（exact / semantic）

- 客观小题：学生选项与正确项一致即满分，exact 比对。
- 翻译小题：按 quiz-gen-translation 的采分点折算，semantic 判分。
- 内容概括题判分时，错误选项的「错在哪」要可指认到原文具体位置（用于错题归因）。
