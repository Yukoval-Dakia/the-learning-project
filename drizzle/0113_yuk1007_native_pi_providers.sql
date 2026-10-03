-- Migrate active routing configuration only. Historical runs and journal entries stay immutable.
-- Credentials are environment-owned: operators rename ZHIPU_API_KEY to ZAI_CODING_CN_API_KEY
-- for the AI lane (OCR/memory may still consume ZHIPU_API_KEY independently).
DO $$
DECLARE
  changed record;
  next_revision integer;
  next_epoch bigint;
  did_change boolean := false;
  unsupported_pairs text;
BEGIN
  LOCK TABLE system_config_epoch IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE system_config IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE system_config_journal IN SHARE ROW EXCLUSIVE MODE;
  SELECT string_agg(m.key || '=' || (m.value #>> '{}'), ', ' ORDER BY m.key)
    INTO unsupported_pairs
    FROM system_config m
    WHERE (m.key ~ '^(task|lane)\.[^.]+\.model$' OR m.key = 'JUDGE_CALIBRATION_REJUDGE_MODEL')
      AND m.value NOT IN ('"glm-5.2"'::jsonb, '"glm-4.6v"'::jsonb, '"glm-5.3"'::jsonb,
        '"glm-5.3-flash"'::jsonb, '"glm-5.3-highspeed"'::jsonb)
      AND EXISTS (
        SELECT 1 FROM system_config p WHERE p.value = '"zhipu"'::jsonb
          AND (p.key = regexp_replace(m.key, '\.model$', '.provider')
            OR (m.key = 'JUDGE_CALIBRATION_REJUDGE_MODEL' AND p.key = 'JUDGE_CALIBRATION_REJUDGE_PROVIDER')
            OR (p.key = 'lane.global.provider' AND m.key ~ '^task\.[^.]+\.model$'
                AND (m.value #>> '{}') LIKE 'glm-%'))
      );
  IF unsupported_pairs IS NOT NULL THEN
    RAISE EXCEPTION 'YUK-1007: retired Zhipu models require an explicit native replacement before migration: %; choose glm-5.3/glm-5.3-flash/glm-5.3-highspeed/glm-4.6v', unsupported_pairs;
  END IF;
  FOR changed IN
    WITH old_providers AS (
      SELECT key FROM system_config
      WHERE value = '"zhipu"'::jsonb
        AND (key ~ '^(task|lane)\.[^.]+\.provider$'
          OR key IN ('JUDGE_FALLBACK_PROVIDER', 'JUDGE_CALIBRATION_REJUDGE_PROVIDER'))
    ), replacements AS (
      SELECT key, '"zai-coding-cn"'::jsonb AS value FROM old_providers
      UNION ALL
      SELECT c.key, '"glm-5.3"'::jsonb FROM system_config c
      WHERE c.value = '"glm-5.2"'::jsonb
        AND (c.key ~ '^(task|lane)\.[^.]+\.model$' OR c.key = 'JUDGE_CALIBRATION_REJUDGE_MODEL')
        AND EXISTS (
          SELECT 1 FROM old_providers p
          WHERE p.key = regexp_replace(c.key, '\.model$', '.provider')
             OR (c.key = 'JUDGE_CALIBRATION_REJUDGE_MODEL' AND p.key = 'JUDGE_CALIBRATION_REJUDGE_PROVIDER')
             OR (p.key = 'lane.global.provider' AND c.key ~ '^task\.[^.]+\.model$'
                 AND (c.value #>> '{}') LIKE 'glm-%')
        )
      UNION ALL
      SELECT key, (value - 'zhipu') || jsonb_build_object('zai-coding-cn', value->'zhipu')
      FROM system_config
      WHERE key = 'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON' AND value ? 'zhipu'
        AND NOT value ? 'zai-coding-cn'
    )
    SELECT c.key, c.value AS previous_value, r.value AS next_value, c.revision
    FROM system_config c JOIN replacements r ON r.key = c.key ORDER BY c.key
  LOOP
    SELECT greatest(changed.revision, coalesce(max(revision), 0)) + 1 INTO next_revision
      FROM system_config_journal WHERE key = changed.key;
    UPDATE system_config SET value = changed.next_value, revision = next_revision,
      updated_by = 'migrate', updated_at = now(), source_note = 'YUK-1007 native pi provider migration'
      WHERE key = changed.key;
    INSERT INTO system_config_journal(key, revision, payload, action, actor, created_at)
      VALUES (changed.key, next_revision,
        jsonb_build_object('prev', changed.previous_value, 'next', changed.next_value,
          'note', 'YUK-1007 native pi provider migration'), 'set', 'migrate', now());
    did_change := true;
  END LOOP;
  -- A conflicting policy must be resolved explicitly; never discard either set of limits.
  IF EXISTS (SELECT 1 FROM system_config WHERE key = 'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON'
    AND value ? 'zhipu' AND value ? 'zai-coding-cn') THEN
    RAISE EXCEPTION 'YUK-1007: conflicting zhipu/zai-coding-cn session policies; reconcile before migration';
  END IF;
  IF did_change THEN
    INSERT INTO system_config_epoch(id, epoch, updated_at)
      VALUES ('global', nextval('config_change_seq'), now())
      ON CONFLICT (id) DO UPDATE SET epoch = greatest(excluded.epoch, system_config_epoch.epoch + 1), updated_at = now()
      RETURNING epoch INTO next_epoch;
    PERFORM setval('config_change_seq', greatest(next_epoch, (SELECT last_value FROM config_change_seq)), true);
  END IF;
END $$;
