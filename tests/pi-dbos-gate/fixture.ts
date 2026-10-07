import type {
  ArrangeCommand,
  Snapshot,
} from '@/capabilities/practice/testing/pi-dbos-gate/operations';

export function answerFixture(evidenceId: string, independent = false) {
  return {
    evidenceId,
    questionId: independent ? 'ellipse-2026-independent-18' : 'ellipse-2026-transfer-17',
    independent,
    correct: independent,
    answer: (independent
      ? '独立作答另一题：椭圆 x²/25 + y²/9 = 1，焦点为 (±4,0)。从隐式求导得到普通点切线 x₀x/25 + y₀y/9 = 1；顶点 (±5,0) 用竖直切线 x=±5 检查，没有除以零。没有看提示，代入一般点核验了方程。一次独立成功仍不足以断言稳定掌握，需要后续不同表述的迁移题。\n'
      : '椭圆 x²/25 + y²/9 = 1，焦点为 (±4,0)。先用了切线公式，但把斜率与点的坐标混在一起；老师提示后得到局部结论，尚未独立完成迁移。\n'
    ).repeat(32),
    misconceptions: independent ? [] : ['tangent-slope-coordinate-confusion'],
    observations: [
      { part: 'a', note: '焦距计算独立正确，不能据此推断切线迁移掌握。', confidence: 0.91 },
      {
        part: 'b',
        note: independent
          ? '未使用提示，切线推导独立正确；还需另一种题面复验稳定性。'
          : '有教师提示，暂时理解与独立迁移须分开；涂改导致两种解释。',
        confidence: independent ? 0.82 : 0.46,
      },
      {
        part: 'c',
        note: independent
          ? '竖直切线边界已验证，长期保持与非标准问法尚未知。'
          : '边界情况 x=±5 尚未验证，后续安排应保留不确定性。',
        confidence: independent ? 0.72 : 0.2,
      },
    ],
  };
}

// Controlled model policy, not a claim of actual provider quality or mastery estimation.
export function modelCommand(
  snapshot: Snapshot,
  operationId: string,
  validUntil: string,
): ArrangeCommand {
  return {
    learnerId: snapshot.learnerId,
    operationId,
    expectedVersion: snapshot.version,
    validUntil,
    nextActivity:
      snapshot.evidence.independent && snapshot.evidence.correct
        ? 'ellipse-transfer'
        : 'ellipse-supported-review',
    rationale:
      '基于不可变作答证据及帮助程度安排下一项；教师提示后的局部正确不等同于独立迁移，保留边界情况与不确定性。',
  };
}
