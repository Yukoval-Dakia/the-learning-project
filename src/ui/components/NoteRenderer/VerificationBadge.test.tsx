import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VerificationBadge } from './VerificationBadge';

describe('VerificationBadge', () => {
  it('renders the key status labels and tones', () => {
    const html = renderToString(
      <div>
        <VerificationBadge status="verified" />
        <VerificationBadge status="pending" />
        <VerificationBadge status="failed" />
        <VerificationBadge status="outdated" />
      </div>,
    );

    expect(html).toContain('已验证');
    expect(html).toContain('待验证');
    expect(html).toContain('验证失败');
    expect(html).toContain('已过期');
    expect(html).toContain('verification-badge--good');
    expect(html).toContain('verification-badge--info');
    expect(html).toContain('verification-badge--again');
    expect(html).toContain('verification-badge--warn');
  });

  it('renders failed issue details behind the clickable badge panel', () => {
    const html = renderToString(
      <VerificationBadge
        status="failed"
        summary="AI verification failed before producing a full report."
        issues={[
          {
            section_id: 's1',
            severity: 'error',
            category: 'factuality',
            message: '公式引用不成立',
          },
        ]}
      />,
    );

    expect(html).toContain('<details');
    expect(html).toContain('verification-badge__panel');
    expect(html).toContain('AI verification failed');
    expect(html).toContain('公式引用不成立');
    expect(html).toContain('error');
    expect(html).toContain('factuality');
  });
});
