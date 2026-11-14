import { afterEach, describe, expect, it } from 'vitest';
import { readQuestionAdmissionConfig } from './question-admission';
import { resetTestConfig, setTestConfig } from './store';

afterEach(resetTestConfig);

describe('question admission config', () => {
  // @invariant data: paid input never freezes an empty policy id
  // @fails-if accept an explicit empty policy before the paid claim boundary
  it('rejects an explicit empty policy override', () => {
    setTestConfig({ QUESTION_ADMISSION_POLICY_ID: '' });

    expect(() => readQuestionAdmissionConfig()).toThrow(/invalid question admission config value/);
  });
});
