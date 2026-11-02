import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import type { QuestionFullDetail } from './library-api';

interface Figure {
  assetId: string | null;
  caption: string | null;
}

/** Every picture the question carries: its figures first, then any other attached images. */
function figuresOf(detail: Pick<QuestionFullDetail, 'figures' | 'image_refs'>): Figure[] {
  const out: Figure[] = [];
  const seen = new Set<string>();
  const raw = Array.isArray(detail.figures) ? (detail.figures as unknown[]) : [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const f = item as { asset_id?: unknown; caption?: unknown };
    const assetId = typeof f.asset_id === 'string' && f.asset_id ? f.asset_id : null;
    const caption = typeof f.caption === 'string' && f.caption.trim() ? f.caption.trim() : null;
    if (assetId) {
      if (seen.has(assetId)) continue;
      seen.add(assetId);
    }
    out.push({ assetId, caption });
  }
  for (const assetId of detail.image_refs ?? []) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    out.push({ assetId, caption: null });
  }
  return out;
}

/** The question's pictures, under the stem. A figure with no stored image still says it exists. */
export function QuestionFigures({
  detail,
}: {
  detail: Pick<QuestionFullDetail, 'figures' | 'image_refs'>;
}) {
  const figures = figuresOf(detail);
  if (figures.length === 0) return null;
  return (
    <ul className="qd-figures" aria-label={`题目配图 ${figures.length} 张`}>
      {figures.map((figure, index) => {
        const label = figure.caption ?? `题目配图 ${index + 1}`;
        return (
          <li key={figure.assetId ?? `missing-${index}`} className="qd-figure">
            {figure.assetId ? (
              <AssetEvidencePreview assetId={figure.assetId} label={label} variant="inline" />
            ) : (
              <span className="qd-figure-missing">这里有一张图，但图片没有存下来。</span>
            )}
            <span className="qd-figure-caption">{label}</span>
          </li>
        );
      })}
    </ul>
  );
}
