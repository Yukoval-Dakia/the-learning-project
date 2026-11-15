export interface MisconceptionTraceTarget {
  misconceptionId: string;
  segment: 'candidate' | 'confirmed';
}

export interface MisconceptionEvidenceOrigin extends MisconceptionTraceTarget {
  knowledgeId: string;
  returnToPlan: boolean;
}

export function readMisconceptionTraceTarget(
  search: Record<string, unknown>,
): MisconceptionTraceTarget | undefined {
  if (
    typeof search.misconceptionId !== 'string' ||
    search.misconceptionId.length === 0 ||
    (search.segment !== 'candidate' && search.segment !== 'confirmed')
  ) {
    return undefined;
  }
  return { misconceptionId: search.misconceptionId, segment: search.segment };
}

export function misconceptionCardId(target: MisconceptionTraceTarget): string {
  return `misconception-${target.segment}-${encodeURIComponent(target.misconceptionId)}`;
}

function originSearch(origin: MisconceptionEvidenceOrigin): URLSearchParams {
  const search = new URLSearchParams({
    misconceptionId: origin.misconceptionId,
    segment: origin.segment,
  });
  if (origin.returnToPlan) search.set('returnTo', 'learning-plan');
  return search;
}

export function misconceptionReturnHref(origin: MisconceptionEvidenceOrigin): string {
  return `/knowledge/${encodeURIComponent(origin.knowledgeId)}?${originSearch(origin)}#${encodeURIComponent(misconceptionCardId(origin))}`;
}

export function withMisconceptionOrigin(href: string, origin: MisconceptionEvidenceOrigin): string {
  if (!/^\/events\/[^/?#]+$/.test(href)) return href;
  const search = originSearch(origin);
  search.set('knowledgeId', origin.knowledgeId);
  return `${href}?${search}`;
}
