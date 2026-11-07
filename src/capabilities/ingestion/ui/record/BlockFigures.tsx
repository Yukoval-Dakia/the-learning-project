import { useAssetUrl } from '@/ui/lib/assets';
import { type LineFigure, figuresOf } from './block-text';
import type { Block } from './record-api';

function Figure({ figure }: { figure: LineFigure }) {
  const { url, error } = useAssetUrl(figure.assetId);
  const words = [
    figure.label,
    figure.handwriting ? '可能带手写' : null,
    error ? '图读不出来' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <figure className="rc-fig">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" aria-label={`${figure.alt}，打开原图`}>
          <img src={url} alt={figure.alt} />
        </a>
      ) : (
        <span className="rc-fig-blank" />
      )}
      {words && <figcaption>{words}</figcaption>}
    </figure>
  );
}

/** A question's own figures: those of the question first, then its options, each under its letter. */
export function BlockFigures({ block }: { block: Block }) {
  const figures = figuresOf(block);
  if (figures.length === 0) return null;
  return (
    <div className="rc-figs">
      {figures.map((figure) => (
        <Figure key={figure.key} figure={figure} />
      ))}
    </div>
  );
}
