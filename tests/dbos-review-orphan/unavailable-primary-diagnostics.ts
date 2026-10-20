// Only the approved unavailable-primary proxy/worker use this closed vocabulary.
// Never return SQL text, parameters, identifiers, or a serialization of an error.
export function unavailableSqlClass(query: unknown) {
  if (typeof query !== 'string') return query === undefined ? 'absent' : 'unknown';
  const text = query.trim().replace(/\s+/g, ' ').toLowerCase();
  // Match postgres 3.4.9 fetchArrayTypes, rather than attributing any pg_type read to it.
  if (
    text ===
    "select b.oid, b.typarray from pg_catalog.pg_type a left join pg_catalog.pg_type b on b.oid = a.typelem where a.typcategory = 'a' group by b.oid, b.typarray order by b.oid"
  )
    return 'internal-pg-type';
  if (/^begin\b/.test(text)) return 'BEGIN';
  if (/^commit\b/.test(text)) return 'COMMIT';
  if (/^rollback\b/.test(text)) return 'ROLLBACK';
  if (/^select\b/.test(text)) return 'domain-read';
  if (/^(insert|update|delete)\b/.test(text)) return 'domain-write';
  if (/^with\b/.test(text)) return 'domain-read-write';
  return 'other';
}
