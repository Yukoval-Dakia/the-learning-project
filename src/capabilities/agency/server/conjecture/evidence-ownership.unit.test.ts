import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('conjecture evidence capability ownership', () => {
  it('keeps the agency-owned reader behind the knowledge public contract', () => {
    const enrichment = source('src/capabilities/agency/server/conjecture/evidence-enrichment.ts');
    const job = source('src/capabilities/agency/jobs/research_meeting_nightly.ts');

    // YUK-892 — subject/domain resolution reads moved to kernel read models.
    expect(enrichment).toContain("from '@/kernel/read-models/knowledge-tree'");
    expect(enrichment).not.toContain('@/capabilities/knowledge/server/');
    expect(enrichment).not.toContain("from '@/server/");
    expect(source('src/capabilities/agency/server/conjecture/evidence.ts')).not.toContain(
      "from '@/server/",
    );
    expect(job).toContain("from '@/capabilities/agency/server/conjecture/evidence-enrichment'");
    expect(job).not.toContain('@/server/conjectures/enrich');
  });
});
