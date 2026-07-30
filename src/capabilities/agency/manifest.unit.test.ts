import { describe, expect, it } from 'vitest';

import { agencyCapability } from './manifest';

describe('agency scheduled jobs', () => {
  // YUK-758 — research_meeting_nightly is now an orchestrated DAG root (no cron);
  // coach_weekly stays bare cron (weekly scans stay out of the nightly DAG).
  it('makes research_meeting a DAG root while coach_weekly keeps its Sunday cron', () => {
    const handlers = agencyCapability.jobs?.handlers ?? [];
    const researchMeeting = handlers.find((handler) => handler.name === 'research_meeting_nightly');
    const weeklyCoach = handlers.find((handler) => handler.name === 'coach_weekly');

    expect(researchMeeting?.schedule).toBeUndefined();
    expect(researchMeeting?.dependsOn).toEqual([]);
    expect(weeklyCoach?.schedule).toEqual({ cron: '30 4 * * 0', tz: 'Asia/Shanghai' });
    expect(weeklyCoach?.dependsOn).toBeUndefined();
  });

  // YUK-758 — dreaming/knowledge_maintenance soft-depend on the propose producers
  // (read the proposal inbox as a dedup base; upstream failure → run anyway, stale).
  it('wires dreaming_nightly soft edges to the propose producers', () => {
    const handlers = agencyCapability.jobs?.handlers ?? [];
    const dreaming = handlers.find((handler) => handler.name === 'dreaming_nightly');
    expect(dreaming?.schedule).toBeUndefined();
    expect(dreaming?.dependsOn).toEqual([
      { job: 'knowledge_edge_propose_nightly', soft: true },
      { job: 'knowledge_maintenance_nightly', soft: true },
    ]);
  });
});

describe('agency event subscriptions', () => {
  it('settles intervention diagnostics from canonical trusted judge events', () => {
    const handlers = agencyCapability.subscriptions?.handlers ?? [];
    expect(
      handlers.find((handler) => handler.id === 'agency.intervention-diagnostic-review-settlement'),
    ).toMatchObject({
      version: 2,
      actions: ['judge'],
    });
  });
});
