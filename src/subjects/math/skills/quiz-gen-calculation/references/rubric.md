# 数学计算题评分细则

供质检 `kind_conformance` / `solve-check` 与未来 judge 判分共用。

## 一、题目合格性细则（kind_conformance）

一道计算题**合格**当且仅当：

1. 条件充分且相容，所求明确无歧义，公式用 LaTeX 书写。
2. `reference_md` 给出完整解题步骤：列条件 → 标依据 → 保留关键中间式 → 得最终答案 + 检验。
3. 有唯一确定的最终答案；结构化答案给出 `final_answer`（+ 必要时 `answer_equivalents` 等价形式）。
4. 题真的可解、参考答案真的对（solve-check 用独立 solver 复核会通过）。
5. 选择题形式：4 个选项，干扰项设在真实计算/方法错误上。

任一不满足 → 不合格。

## 二、solve-check 比对细则

- 独立 solver 解出 `final_answer` 后，与题面参考答案做 normalize 比对（忽略空白、等价分数/小数、集合顺序）。
- `answer_equivalents` 命中任一即视为一致。
- solver 答案与参考答案确定性不一致 → solve-check fail（题或答案有错）。
- solver 解不出 / 输出不可解析 → unsupported（保守不误杀，不判 fail）。

## 三、学生答案判分细则

- 只验最终答案：exact / normalize 比对（容忍等价书写）。
- 验过程要点：semantic + `required_points`（每个关键步骤一条），漏关键步骤或方法错误扣分。
