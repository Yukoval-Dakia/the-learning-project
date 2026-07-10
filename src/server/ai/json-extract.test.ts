// YUK-607 — 修复带提取器单测。fixture 类别对应 spike（2026-07-10）观测到的 mimo 失败类：
// 字符串值内未转义 ASCII 引号（三次生成失败均为此类，错误都在 line 1——单行 JSON 内早断），
// 另铺裸换行 / 智能引号两个近邻类 + 「修不回则重抛原始错误」的字节级契约。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseJsonObjectLoose } from './json-extract';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseJsonObjectLoose (YUK-607 repair band)', () => {
  it('严格合法 JSON（含前后散文包裹）原样通过，repaired=false，不触发 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseJsonObjectLoose('说明文字 {"a": 1, "b": "文"} 收尾', 'site');
    expect(r).toEqual({ json: { a: 1, b: '文' }, repaired: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('文本无完整 {...} → null（调用点用自己的措辞抛错）', () => {
    expect(parseJsonObjectLoose('no json here', 'site')).toBeNull();
    expect(parseJsonObjectLoose('{ 只开不合', 'site')).toBeNull();
  });

  it('字符串值内未转义 ASCII 引号（spike 观测类）→ 修复成功且内容零丢失', () => {
    const text =
      '{"questions": [{"kind": "reading_comprehension", "prompt_md": "文中说"论证要有力"，请辨析下列论证方法。"}]}';
    // 前提自证：严格解析对该类确实失败（与生产 parseOutput 报错同类）
    expect(() => JSON.parse(text)).toThrow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseJsonObjectLoose(text, 'site');
    expect(r?.repaired).toBe('deterministic');
    const j = r?.json as { questions: Array<{ kind: string; prompt_md: string }> };
    expect(j.questions[0].kind).toBe('reading_comprehension');
    expect(j.questions[0].prompt_md).toContain('论证要有力');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('site');
  });

  it('真实坏件形状（spike 捕获）：长中文串内成对 ASCII 引号、两侧全 CJK —— jsonrepair 单独翻车的形态，确定性转义层兜住', () => {
    // 按 2026-07-10 spike 诊断 snippet 重建：`引用古语"读书百遍，其义自见"进行说理`——
    // 两个内容引号两侧都是 CJK 字符；实测 jsonrepair 对此形态报 "Colon expected"。
    const text =
      '{"questions":[{"kind":"single_choice","prompt_md":"下列对语段论证方法的判断正确的一项是？","reference_md":"正确选项：D（道理论证）\\n\\n解析：语段通过引用古语"读书百遍，其义自见"进行说理，再辅以理性分析来论证观点，属于道理论证。","choices_md":["A. 举例论证","B. 对比论证","C. 比喻论证","D. 道理论证"]}]}';
    expect(() => JSON.parse(text)).toThrow();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseJsonObjectLoose(text, 'site');
    expect(r?.repaired).toBe('deterministic');
    const j = r?.json as {
      questions: Array<{ kind: string; reference_md: string; choices_md: string[] }>;
    };
    expect(j.questions[0].kind).toBe('single_choice');
    expect(j.questions[0].reference_md).toContain('读书百遍，其义自见');
    expect(j.questions[0].reference_md).toContain('道理论证');
    expect(j.questions[0].choices_md).toHaveLength(4);
  });

  it('字符串值内裸换行 → 修复成功，段落保留', () => {
    const text = '{"prompt_md": "第一段材料\n\n第二段材料", "kind": "reading_comprehension"}';
    expect(() => JSON.parse(text)).toThrow();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseJsonObjectLoose(text, 'site');
    expect(r?.repaired).toBe('deterministic'); // sanitizeJsonStringLiterals 级，内容保真
    const j = r?.json as { prompt_md: string; kind: string };
    expect(j.prompt_md).toContain('第一段材料');
    expect(j.prompt_md).toContain('第二段材料');
    expect(j.kind).toBe('reading_comprehension');
  });

  it('智能引号定界 → 修复成功', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseJsonObjectLoose('{“kind”: “translation”}', 'site');
    expect(r?.repaired).toBe('jsonrepair'); // 智能引号非 ASCII `"`，确定性层不触及
    expect((r?.json as { kind: string }).kind).toBe('translation');
  });

  it('ASCII 标点毗邻引号（review MAJOR 复现形态）→ 如实落 jsonrepair 级；reject 模式重抛原始错误', () => {
    // jsonrepair 对该形态会静默重划字符串边界（截断内容 + 伪造 key）——level 必须如实标
    // 'jsonrepair' 供持久化站点隔离（quiz_gen → parse_repaired → verify 封顶 needs_review）；
    // 无隔离门的站点（sourcing）用 riskyRepair:'reject' 保持响亮失败。
    const text = '{"note": "set "A", not "B""}';
    expect(() => JSON.parse(text)).toThrow();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseJsonObjectLoose(text, 'site');
    expect(r?.repaired).toBe('jsonrepair');
    let originalMessage = '';
    try {
      JSON.parse(text);
    } catch (e) {
      originalMessage = (e as Error).message;
    }
    expect(() => parseJsonObjectLoose(text, 'site', { riskyRepair: 'reject' })).toThrow(
      originalMessage,
    );
  });

  it('复合坏件（CJK 内容引号 + 尾逗号）→ 确定性层修引号、jsonrepair 收尾逗号，内容零丢失', () => {
    // 强制走梯度末级：引号形态 jsonrepair(原文) 会翻车（Colon expected），尾逗号确定性层
    // 不治——只有 jsonrepair(确定性结果) 能成。
    const text =
      '{"kind": "single_choice", "prompt_md": "语段通过引用古语"读书百遍，其义自见"进行说理，判断其论证方法。",}';
    expect(() => JSON.parse(text)).toThrow();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseJsonObjectLoose(text, 'site');
    expect(r?.repaired).toBe('jsonrepair');
    const j = r?.json as { kind: string; prompt_md: string };
    expect(j.kind).toBe('single_choice');
    expect(j.prompt_md).toContain('读书百遍，其义自见');
  });

  it('修复也救不回 → 重抛严格解析的【原始】错误（调用点错误串格式逐字节不变）', () => {
    // 注意：本 fixture 钉在 jsonrepair@3.x 对 '{;}' 的拒绝行为上（今日实证 'Colon expected'）。
    // 若未来升级使其可修，本断言会【响亮】变红（toThrow 失败），届时换一个双杀 fixture 即可
    // ——不会静默放行（review MINOR 已知）。
    const hopeless = '{;}';
    let originalMessage = '';
    try {
      JSON.parse(hopeless);
    } catch (e) {
      originalMessage = (e as Error).message;
    }
    expect(originalMessage).not.toBe('');
    expect(() => parseJsonObjectLoose(hopeless, 'site')).toThrow(originalMessage);
  });
});
