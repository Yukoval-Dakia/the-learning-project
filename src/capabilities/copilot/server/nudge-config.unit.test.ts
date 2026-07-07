import { describe, expect, it } from 'vitest';
import { loadNudgeConfig } from './nudge-config';

// YUK-577 §3.7 — SHADOW model: enabled only gates surfacing (strict '1'); numeric params fall back.

describe('loadNudgeConfig', () => {
  it('defaults: OFF, dailyMax 3, expiresHours 24', () => {
    expect(loadNudgeConfig({})).toEqual({ enabled: false, dailyMax: 3, expiresHours: 24 });
  });

  it('enabled only when strictly "1"', () => {
    expect(loadNudgeConfig({ COPILOT_NUDGE_ENABLED: '1' }).enabled).toBe(true);
    expect(loadNudgeConfig({ COPILOT_NUDGE_ENABLED: 'true' }).enabled).toBe(false);
    expect(loadNudgeConfig({ COPILOT_NUDGE_ENABLED: '0' }).enabled).toBe(false);
  });

  it('parses positive integer params; falls back on garbage/non-positive', () => {
    expect(loadNudgeConfig({ COPILOT_NUDGE_DAILY_MAX: '5' }).dailyMax).toBe(5);
    expect(loadNudgeConfig({ COPILOT_NUDGE_DAILY_MAX: 'x' }).dailyMax).toBe(3);
    expect(loadNudgeConfig({ COPILOT_NUDGE_DAILY_MAX: '0' }).dailyMax).toBe(3);
    expect(loadNudgeConfig({ COPILOT_NUDGE_EXPIRES_HOURS: '48' }).expiresHours).toBe(48);
  });
});
