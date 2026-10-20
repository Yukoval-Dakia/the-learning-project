import { useAssetUrl } from '@/ui/lib/assets';

function Page({ assetId, index, lit }: { assetId: string; index: number; lit: boolean }) {
  const { url } = useAssetUrl(assetId);
  return (
    <li className="rc-tile" data-lit={lit}>
      {url ? <img src={url} alt={`第 ${index + 1} 页`} /> : <span className="rc-tile-blank" />}
      <span className="rc-tile-no un-num">{index + 1}</span>
    </li>
  );
}

/** The recording's own pages, in order; the page a hovered question sits on is lit. */
export function PageStrip({ assetIds, litPage }: { assetIds: string[]; litPage: number | null }) {
  if (assetIds.length === 0) return null;
  return (
    <ol className="rc-tiles" aria-label="这次放进来的页">
      {assetIds.map((id, i) => (
        <Page key={id} assetId={id} index={i} lit={litPage === i + 1} />
      ))}
    </ol>
  );
}
