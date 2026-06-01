import {
  ConversationStatus,
  IngestionStatus,
  LearningSessionStatusByType,
  LearningSessionType,
  ReviewStatus,
} from '@/core/schema/learning_session';
import { describe, expect, it } from 'vitest';

describe('LearningSessionType', () => {
  it('accepts all 6 enum values', () => {
    for (const t of ['ingestion', 'review', 'tutor', 'explore', 'create', 'conversation']) {
      expect(LearningSessionType.safeParse(t).success).toBe(true);
    }
  });

  it('rejects unknown type', () => {
    expect(LearningSessionType.safeParse('quiz').success).toBe(false);
  });
});

describe('IngestionStatus', () => {
  it('accepts all 8 ingestion states (ADR-0005)', () => {
    for (const s of [
      'uploaded',
      'queued',
      'extracting',
      'extracted',
      'partial',
      'failed',
      'reviewed',
      'imported',
    ]) {
      expect(IngestionStatus.safeParse(s).success).toBe(true);
    }
  });

  it('rejects review-only status leaking into ingestion enum', () => {
    expect(IngestionStatus.safeParse('completed').success).toBe(false);
  });
});

describe('ReviewStatus', () => {
  it('accepts started/completed/abandoned', () => {
    expect(ReviewStatus.safeParse('started').success).toBe(true);
    expect(ReviewStatus.safeParse('completed').success).toBe(true);
    expect(ReviewStatus.safeParse('abandoned').success).toBe(true);
  });

  it('rejects ingestion status under review enum', () => {
    expect(ReviewStatus.safeParse('extracted').success).toBe(false);
  });
});

describe('ConversationStatus', () => {
  it('accepts active/idle/ended', () => {
    expect(ConversationStatus.safeParse('active').success).toBe(true);
    expect(ConversationStatus.safeParse('idle').success).toBe(true);
    expect(ConversationStatus.safeParse('ended').success).toBe(true);
  });
});

describe('LearningSessionStatusByType (discriminated union)', () => {
  it('accepts valid (ingestion, queued)', () => {
    expect(
      LearningSessionStatusByType.safeParse({ type: 'ingestion', status: 'queued' }).success,
    ).toBe(true);
  });

  it('accepts valid (review, completed)', () => {
    expect(
      LearningSessionStatusByType.safeParse({ type: 'review', status: 'completed' }).success,
    ).toBe(true);
  });

  it('accepts valid (conversation, active)', () => {
    expect(
      LearningSessionStatusByType.safeParse({ type: 'conversation', status: 'active' }).success,
    ).toBe(true);
  });

  it('rejects status mismatched to type (review with ingestion status)', () => {
    expect(
      LearningSessionStatusByType.safeParse({ type: 'review', status: 'extracted' }).success,
    ).toBe(false);
  });

  it('rejects status mismatched to type (ingestion with review status)', () => {
    expect(
      LearningSessionStatusByType.safeParse({ type: 'ingestion', status: 'completed' }).success,
    ).toBe(false);
  });

  it('accepts placeholder for explore/create (tutor now has a real machine)', () => {
    expect(
      LearningSessionStatusByType.safeParse({ type: 'explore', status: 'placeholder' }).success,
    ).toBe(true);
    expect(
      LearningSessionStatusByType.safeParse({ type: 'create', status: 'placeholder' }).success,
    ).toBe(true);
  });

  it('accepts the real tutor states (YUK-193 solve-tutor state machine)', () => {
    for (const s of ['active', 'submitted', 'judged', 'ended', 'abandoned']) {
      expect(LearningSessionStatusByType.safeParse({ type: 'tutor', status: s }).success).toBe(
        true,
      );
    }
  });

  it('rejects placeholder status for tutor (real state machine now defined, YUK-193)', () => {
    expect(
      LearningSessionStatusByType.safeParse({ type: 'tutor', status: 'placeholder' }).success,
    ).toBe(false);
  });
});
