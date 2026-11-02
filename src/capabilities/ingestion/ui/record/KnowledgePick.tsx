import { useId, useState } from 'react';
import { useKnowledgeList } from './recording-read';

const MAX_MATCHES = 6;

/**
 * Which knowledge point(s) a question belongs to. Picked ones read as a short sentence with a
 * remove button each; typing shows up to six matches to add. The library needs at least one.
 */
export function KnowledgePick({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const q = useKnowledgeList();
  const [term, setTerm] = useState('');
  const inputId = useId();
  const nodes = q.data ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const t = term.trim().toLowerCase();
  const matches = t
    ? nodes
        .filter((n) => !value.includes(n.id))
        .filter(
          (n) =>
            n.name.toLowerCase().includes(t) ||
            (n.effective_domain ?? '').toLowerCase().includes(t),
        )
        .slice(0, MAX_MATCHES)
    : [];

  return (
    <div className="rc-kp">
      <div className="rc-kp-line">
        <label className="rc-kp-label" htmlFor={inputId}>
          知识点
        </label>
        {value.map((id) => (
          <span key={id} className="rc-kp-token">
            {byId.get(id)?.name ?? '已选的知识点'}
            <button
              type="button"
              className="rc-kp-x un-hit"
              aria-label={`去掉 ${byId.get(id)?.name ?? '这个知识点'}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((x) => x !== id))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={inputId}
          className="rc-kp-input"
          value={term}
          disabled={disabled}
          placeholder={value.length === 0 ? '打几个字找一找' : '再加一个'}
          autoComplete="off"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) {
              e.preventDefault();
              onChange([...value, matches[0].id]);
              setTerm('');
            }
          }}
        />
      </div>
      {q.isError && <p className="rc-quiet">知识点列表暂时没取到，稍后再选。</p>}
      {t && matches.length === 0 && q.isSuccess && (
        <p className="rc-quiet">没找到「{term.trim()}」，换个说法试试。</p>
      )}
      {matches.length > 0 && (
        <ul className="rc-kp-matches" aria-label="找到的知识点">
          {matches.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="rc-kp-match un-hit"
                onClick={() => {
                  onChange([...value, n.id]);
                  setTerm('');
                }}
              >
                <span>{n.name}</span>
                {n.effective_domain && <span className="rc-quiet">{n.effective_domain}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
