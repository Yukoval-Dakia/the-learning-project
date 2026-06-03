// SkLines — shimmering skeleton rows. className-driven over the .sk / .sk-stack /
// .sk-line class layer in app/globals.css. Ported from
// docs/design/loom-prototype/components.jsx (SkLines).

export interface SkLinesProps {
  rows?: number;
}

export function SkLines({ rows = 3 }: SkLinesProps) {
  return (
    <div className="sk-stack">
      {Array.from({ length: rows }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows, no reorder/identity
        <div key={i} className="sk-line">
          <div
            className="sk"
            style={{ width: 38, height: 38, borderRadius: 'var(--r-2)', flex: 'none' }}
          />
          <div style={{ flex: 1 }}>
            <div className="sk" style={{ width: `${60 - i * 8}%`, height: 13, marginBottom: 8 }} />
            <div className="sk" style={{ width: `${80 - i * 6}%`, height: 11 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
