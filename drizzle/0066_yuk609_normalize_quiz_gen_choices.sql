-- YUK-609 — choices_md stores option bodies; renderers add A/B/C labels from
-- array position. Early quiz_gen rows sometimes persisted labels inside the
-- body ("A. 举例论证"), producing "A. A. 举例论证" in every indexed renderer.
--
-- Data-only, idempotent migration (no schema snapshot). Strip only an ASCII
-- label whose letter matches its 1-based array position and is followed by a
-- punctuation delimiter. Mismatched labels stay visible for draft review rather
-- than silently changing option identity. Empty post-prefix bodies also stay
-- unchanged. Any changed row drops its derived embedding/hash so the existing
-- embed_backfill job recomputes from the normalized source text.
WITH normalized AS (
	SELECT
		q."id",
		jsonb_agg(
			to_jsonb(
				CASE
					WHEN upper(
						substring(
							choice FROM '^[[:space:]]*([A-Za-z])[[:space:]]*[.．。、:：)）]'
						)
					) = chr(64 + ordinality::integer)
						AND btrim(
							regexp_replace(
								choice,
								'^[[:space:]]*[A-Za-z][[:space:]]*[.．。、:：)）][[:space:]]*',
								''
							)
						) <> ''
					THEN btrim(
						regexp_replace(
							choice,
							'^[[:space:]]*[A-Za-z][[:space:]]*[.．。、:：)）][[:space:]]*',
							''
						)
					)
					ELSE choice
				END
			)
			ORDER BY ordinality
		) AS "choices_md"
	FROM "question" q
	CROSS JOIN LATERAL jsonb_array_elements_text(q."choices_md")
		WITH ORDINALITY AS entries(choice, ordinality)
	WHERE q."source" = 'quiz_gen'
		AND jsonb_typeof(q."choices_md") = 'array'
	GROUP BY q."id"
)
UPDATE "question" q
SET
	"choices_md" = normalized."choices_md",
	"embedding" = NULL,
	"embed_content_hash" = NULL,
	"updated_at" = now(),
	"version" = q."version" + 1
FROM normalized
WHERE q."id" = normalized."id"
	AND q."choices_md" IS DISTINCT FROM normalized."choices_md";
