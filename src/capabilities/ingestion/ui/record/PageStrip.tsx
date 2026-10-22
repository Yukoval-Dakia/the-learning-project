import { useAssetUrl } from '@/ui/lib/assets';

function Page({
  assetId,
  index,
  lit,
  numbered,
}: {
  assetId: string;
  index: number;
  lit: boolean;
  numbered: boolean;
}) {
  const { url } = useAssetUrl(assetId);
  return (
    <li className="rc-tile" data-lit={lit}>
      {url ? <img src={url} alt={`第 ${index + 1} 页`} /> : <span className="rc-tile-blank" />}
      {numbered && <span className="rc-tile-no un-num">{index + 1}</span>}
    </li>
  );
}

/**
 * The recording's own pages, in order; the page a hovered question sits on is lit. A single page
 * carries no number, so it is not read as a second question number next to the first line.
 */
export function PageStrip({ assetIds, litPage }: { assetIds: string[]; litPage: number | null }) {
  if (assetIds.length === 0) return null;
  return (
    <ol className="rc-tiles" aria-label="这次放进来的页">
      {assetIds.map((id, i) => (
        <Page
          key={id}
          assetId={id}
          index={i}
          lit={litPage === i + 1}
          numbered={assetIds.length > 1}
        />
      ))}
    </ol>
  );
}
