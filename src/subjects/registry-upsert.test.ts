// YUK-599 — SubjectRegistry 手术面 unit（v2 §2.2 / v2-test-14 承接）：
// upsert register-with-replace、alias 抢占显式 throw（.has 预检 + !==id 放行）、
// normalizeSubjectKey NFC、remove 摘除原语。纯内存零 IO —— unit 分区；
// MUST be listed in fastTestInclude。

import { describe, expect, it } from 'vitest';
import { SubjectRegistry, normalizeSubjectKey, subjectProfiles } from './profile';

function customProfile(id: string, displayName: string) {
  // biome-ignore lint/style/noNonNullAssertion: builtin 恒在
  const base = subjectProfiles.general!;
  return { ...base, id, displayName };
}

describe('normalizeSubjectKey — NFC（v2 §2.2）', () => {
  it('NFC 归一 + trim + lowercase（写门/DB/内存共用同一函数）', () => {
    // 'é' 的分解形（e + U+0301）归一到合成形。
    expect(normalizeSubjectKey('  Café  ')).toBe('café');
    expect(normalizeSubjectKey('MATH')).toBe('math');
    expect(normalizeSubjectKey('化学')).toBe('化学'); // CJK 恒等
  });
});

describe('SubjectRegistry.upsert — register-with-replace（v2 §4 水合）', () => {
  it('新 id 走完整 register；同 id 重装替换 profile + 别名可追加', () => {
    const r = new SubjectRegistry();
    const v1 = customProfile('subj_u1', '化学');
    expect(r.upsert(v1, ['chem']).valid).toBe(true);
    expect(r.get('subj_u1')?.displayName).toBe('化学');
    expect(r.resolveKnownSubjectId('chem')).toBe('subj_u1');

    const v2 = customProfile('subj_u1', '化学基础');
    expect(r.upsert(v2, ['chem', 'chemistry']).valid).toBe(true); // 同科重复声明放行
    expect(r.get('subj_u1')?.displayName).toBe('化学基础'); // DB wins：装配覆盖旧条目
    expect(r.resolveKnownSubjectId('chemistry')).toBe('subj_u1');
  });

  it('alias 抢占显式 throw（v2-test-14）：他科同串不再静默覆盖', () => {
    const r = new SubjectRegistry();
    expect(r.upsert(customProfile('subj_u2', '甲'), ['shared-alias']).valid).toBe(true);
    expect(() => r.upsert(customProfile('subj_u3', '乙'), ['shared-alias'])).toThrow(
      /already claimed by 'subj_u2'/,
    );
    // builtin 自别名同理受保护：抢 'math' 显式炸，不静默改写。
    expect(() => r.upsert(customProfile('subj_u4', '丙'), ['math'])).toThrow(/already claimed/);
  });

  it('upsert 坏 profile：throwOnInvalid:false → 上报不炸（never-throws 水合矩阵）', () => {
    const r = new SubjectRegistry();
    const bad = { ...customProfile('subj_u5', '丁'), languageStyle: '' };
    const result = r.upsert(bad, [], { throwOnInvalid: false });
    expect(result.valid).toBe(false);
    expect(r.get('subj_u5')).toBeUndefined();
  });

  it('remove 摘除 profile + 全部指向它的 alias（防御网原语）', () => {
    const r = new SubjectRegistry();
    r.upsert(customProfile('subj_u6', '戊'), ['wu-alias']);
    expect(r.remove('subj_u6')).toBe(true);
    expect(r.get('subj_u6')).toBeUndefined();
    expect(r.resolveKnownSubjectId('wu-alias')).toBeNull();
    expect(r.remove('subj_u6')).toBe(false); // 二次摘除 = no-op false
  });
});

describe('三集合谓词（YUK-598 / v2 §2.1 两谓词独立）', () => {
  it('retired（状态性）与 isSelectable=false（结构性）各自出 selectable、都留 resolvable', () => {
    const r = new SubjectRegistry();
    r.upsert(customProfile('subj_r1', '退休科'), [], {
      meta: { isBuiltin: false, isSelectable: true, retiredAt: new Date() },
    });
    r.upsert(customProfile('subj_r2', '结构排除科'), [], {
      meta: { isBuiltin: false, isSelectable: false, retiredAt: null },
    });
    r.upsert(customProfile('subj_r3', '活科'), []); // 缺省 meta = 新 custom 默认

    const selectable = r.getSelectableSubjectIds();
    const resolvable = r.getResolvableSubjectIds();
    // 两谓词独立：retired / 结构性 / general 三者都不在 selectable，但全部 resolvable
    // （旧数据串永不悬垂）。
    for (const id of ['subj_r1', 'subj_r2', 'general']) {
      expect(selectable).not.toContain(id);
      expect(resolvable).toContain(id);
    }
    expect(selectable).toEqual(expect.arrayContaining(['yuwen', 'math', 'physics', 'subj_r3']));
    // restore 语义预演：retiredAt 清空后回归 selectable（meta 重喂即翻）。
    r.upsert(customProfile('subj_r1', '退休科'), [], {
      meta: { isBuiltin: false, isSelectable: true, retiredAt: null },
    });
    expect(r.getSelectableSubjectIds()).toContain('subj_r1');
  });
});
