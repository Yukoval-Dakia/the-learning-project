-- YUK-609 — choices_md stores option bodies; renderers add A/B/C labels from
-- array position. Early quiz_gen rows sometimes persisted labels inside the
-- body ("A. 举例论证"), producing "A. A. 举例论证" in every indexed renderer.
--
-- Data-only, idempotent migration (no schema snapshot). Normalize only when the
-- WHOLE array is an A/B/C... indexed set; this avoids corrupting natural option
-- bodies such as "C. elegans". The captured label alone is NFKC-normalized for
-- comparison (PostgreSQL 16 `normalize(text, NFKC)`); the body stays byte-for-byte
-- intact apart from trimming the removed prefix. Any changed row drops its
-- derived embedding/hash so the existing embed_backfill job recomputes it.
WITH choice_parts AS (
	SELECT
		q."id",
		q."choices_md" AS "original_choices_md",
		entries.ordinality,
		normalize(
			substring(
				entries.choice
				FROM '^[[:space:]]*([A-Za-zＡ-Ｚａ-ｚ])[[:space:]]*[.．。、:：)）]'
			),
			NFKC
		) AS "label",
		btrim(
			regexp_replace(
				entries.choice,
				'^[[:space:]]*[A-Za-zＡ-Ｚａ-ｚ][[:space:]]*[.．。、:：)）][[:space:]]*',
				''
			)
		) AS "stripped_body"
	FROM "question" q
	CROSS JOIN LATERAL jsonb_array_elements_text(q."choices_md")
		WITH ORDINALITY AS entries(choice, ordinality)
	WHERE q."source" = 'quiz_gen'
		AND jsonb_typeof(q."choices_md") = 'array'
),
normalized AS (
	SELECT
		"id",
		"original_choices_md",
		jsonb_agg(to_jsonb("stripped_body") ORDER BY ordinality) AS "choices_md",
		bool_and(
			coalesce(
				upper("label") = chr(64 + ordinality::integer) AND "stripped_body" <> '',
				false
			)
		) AS "is_indexed_set"
	FROM choice_parts
	GROUP BY "id", "original_choices_md"
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
	AND normalized."is_indexed_set"
	AND q."choices_md" IS DISTINCT FROM normalized."choices_md";
