---
name: quiz-gen-reading-comprehension
description: 文言文「阅读理解」题组的出题与质检规范包 —— 题组结构（原文 + 配套小题）、各小题题型搭配、设问层次、答案依据要求。当为文言文（wenyan）学科生成或质检 reading_comprehension 题型时加载，让生成的阅读题像真高考/联考文言文阅读题组。
---

# 文言文阅读理解题出题规范

文言文阅读理解不是单题，而是「**一份真实文言原文 + 围绕它的一组小题**」的题组。它考的是在真实语境中综合运用断句、实词、句意理解、内容概括、信息筛选的能力。本规范定义题组结构、设问层次和答案依据标准，供出题（QuizGenTask，走 material_grounded）和质检（QuizVerifyTask 的 kind_conformance + material_grounding 检查）共用。

## 题组结构要求

一道（一组）合格的文言阅读题必须满足：

1. **真实原文作锚**：原文必须是真实存在的文言篇章 / 选段（人物传记、史论、游记、笔记等），**持久化为素材**（material_grounded，落 `source_document`），所有小题都考查这份原文。原文不得自造。
2. **题面明确指向原文**：每道小题的题面要让学生知道「依据上面这篇文章作答」（如「下列对文中加点词的解释，不正确的一项是」）。
3. **答案有原文依据**：每道小题的 `reference_md` 答案必须能在原文里找到依据，质检会核查「题确实考这份素材」。

## 小题题型搭配（一组阅读题的典型构成）

一份文言阅读题组通常由 3–5 道小题组成，覆盖由低到高的设问层次：

1. **实词解释题**（choice，exact）：考查文中加点实词的含义，4 选项中选错误/正确的一项。考点是古今异义、一词多义、活用。
2. **虚词/句式题**（choice，exact）：考查虚词功能或特殊句式判断。
3. **句意理解题**（choice，exact）：「下列对文中句子的理解，正确/错误的一项」，考查对关键句的准确把握。
4. **内容概括/信息筛选题**（choice，exact）：「下列对原文有关内容的概括分析，不正确的一项」——这是阅读题的重头，选项常设「张冠李戴 / 时间地点错位 / 因果倒置 / 无中生有」陷阱。
5. **翻译题**（translation，semantic）：从原文中选 1–2 句要求翻译（可复用 quiz-gen-translation 规范）。

不要求每组都齐全 5 类，但**至少应含一道内容概括题 + 一道实词题**，且各小题考点不重复。

## 设问与选项要求

- 客观小题（实词/句式/句意/概括）一律 `judge_kind_override='exact'`，给 4 个选项，`reference_md` 第一行是正确选项原文 + 简短依据。
- 选项必须**有区分度**：错误选项要设在真实易错点上（如概括题的「无中生有」），不能是明显荒谬的干扰项。
- 翻译小题 `semantic`，`required_points` 必填（见 quiz-gen-translation 规范）。

## 与素材的绑定（material_grounding）

- 出题走 `generation_method='material_grounded'`，顶层 `material` 填原文全文（`body_md`）、出处（`url`/`title`）。
- 每道小题的答案依据必须落在这份 `material` 里；题面只是凑数地附原文、实际考别的内容 → material_grounding 判 fail。

## 引用资源

- `references/rubric.md` — 阅读题组评分细则（质检 kind_conformance + material_grounding 检查共用）。
- `references/anti-patterns.md` — 阅读题坏题反例。
- `assets/few-shot.json` — 精选合格题组范例（few-shot 检索命中时注入）。
