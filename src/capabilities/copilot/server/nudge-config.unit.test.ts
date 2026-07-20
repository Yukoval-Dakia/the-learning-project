import { describe, expect, it } from 'vitest';
import { loadNudgeConfig } from './nudge-config';

// YUK-577 §3.7 — SHADOW model: enabled only gates surfacing; numeric params fall back.

describe('loadNudgeConfig', () => {
  it('defaults: OFF, dailyMax 3, expiresHours 24, streakN 3, kcCooldownHours 24', () => {
    expect(loadNudgeConfig({})).toEqual({
      enabled: false,
      dailyMax: 3,
      expiresHours: 24,
      streakN: 3,
      kcCooldownHours: 24,
    });
  });

  it('uses the shared enabled/disabled literal grammar', () => {
    expect(loadNudgeConfig({ COPILOT_NUDGE_ENABLED: '1' }).enabled).toBe(true);
    expect(loadNudgeConfig({ COPILOT_NUDGE_ENABLED: 'TRUE' }).enabled).toBe(true);
    expect(loadNudgeConfig({ COPILOT_NUDGE_ENABLED: '0' }).enabled).toBe(false);
  });

  it('parses positive integer params; falls back on garbage/non-positive', () => {
    expect(loadNudgeConfig({ COPILOT_NUDGE_DAILY_MAX: '5' }).dailyMax).toBe(5);
    expect(loadNudgeConfig({ COPILOT_NUDGE_DAILY_MAX: 'x' }).dailyMax).toBe(3);
    expect(loadNudgeConfig({ COPILOT_NUDGE_DAILY_MAX: '0' }).dailyMax).toBe(3);
    expect(loadNudgeConfig({ COPILOT_NUDGE_EXPIRES_HOURS: '48' }).expiresHours).toBe(48);
    expect(loadNudgeConfig({ COPILOT_NUDGE_STREAK_N: '4' }).streakN).toBe(4);
    expect(loadNudgeConfig({ COPILOT_NUDGE_STREAK_N: 'x' }).streakN).toBe(3);
    expect(loadNudgeConfig({ COPILOT_NUDGE_KC_COOLDOWN_HOURS: '36' }).kcCooldownHours).toBe(36);
  });
});
