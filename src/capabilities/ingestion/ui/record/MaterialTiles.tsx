import { type Material, fileKey } from './record-start';

export function materialSummary(material: Material | null): string {
  if (!material) return '';
  if (material.kind === 'photo') return '一张照片';
  if (material.kind === 'pages') return `${material.files.length} 张照片，按一份材料来认`;
  if (material.kind === 'pdf') return 'PDF 文件，每一页都会认';
  if (material.kind === 'docx') return 'Word 文件';
  return material.kind === 'invalid' ? material.reason : '';
}

/**
 * The picked material as small pages in order. While uploading, pages not sent yet stay dimmed;
 * before starting, each page can be removed and more can be added.
 */
export function MaterialTiles({
  files,
  previews,
  material,
  uploaded,
  onRemove,
  onAddMore,
}: {
  files: File[];
  previews: string[];
  material: Material | null;
  uploaded?: number;
  onRemove?: (index: number) => void;
  onAddMore?: () => void;
}) {
  return (
    <div className="rc-tiles-wrap">
      <ol className="rc-tiles" aria-label="放进来的材料">
        {files.map((file, i) => (
          <li
            key={fileKey(file)}
            className="rc-tile"
            data-pending={uploaded !== undefined && i >= uploaded}
          >
            {previews[i] ? (
              <img src={previews[i]} alt={`第 ${i + 1} 页`} />
            ) : (
              <span className="rc-tile-doc">{/\.docx$/i.test(file.name) ? 'Word' : 'PDF'}</span>
            )}
            <span className="rc-tile-no un-num">{i + 1}</span>
            {onRemove && (
              <button
                type="button"
                className="rc-tile-x un-hit"
                aria-label={`去掉第 ${i + 1} 页`}
                onClick={() => onRemove(i)}
              >
                ×
              </button>
            )}
          </li>
        ))}
        {onAddMore && material?.kind !== 'pdf' && material?.kind !== 'docx' && (
          <li className="rc-tile rc-tile-add">
            <button type="button" className="un-hit" onClick={onAddMore}>
              <span aria-hidden="true">＋</span>
              <span>再加</span>
            </button>
          </li>
        )}
      </ol>
      <p className={material?.kind === 'invalid' ? 'rc-problem' : 'rc-quiet'}>
        {materialSummary(material)}
      </p>
    </div>
  );
}
