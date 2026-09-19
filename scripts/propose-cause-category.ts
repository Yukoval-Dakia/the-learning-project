// YUK-1016 / 454-B — owner 手动加错因类目的小入口。
//
// 与 LLM 复发提议共用同一落地路径：写 `cause_category` proposal event
// （source='owner'）→ 收件箱 accept → acceptCauseCategoryProposal INSERT
// cause_category_overlay。owner 不在 DB 里直写词表——proposal 边界保留
// human-vet 语义（自己提、自己审、留证据链）。
//
// 用法：
//   pnpm tsx scripts/propose-cause-category.ts \
//     --slug time_pressure --label 时间压力 \
//     --description "时间约束下压缩步骤/跳步导致的错误" \
//     [--subject general] [--reason "近期多次 time-boxed 练习超时"] [--actor yuqi]
//
// slug 只收蛇形英文（语义 id）；`ov_` 前缀由脚本拼接（同 LLM 路径）。脚本只做
// 提议写入——落地仍需收件箱里点 Accept。

import './load-env';

function arg(argv: string[], name: string): string | undefined {
  const eqArg = argv.find((a) => a.startsWith(`--${name}=`));
  if (eqArg) return eqArg.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const rawSlug = arg(argv, 'slug');
  const label = arg(argv, 'label');
  const description = arg(argv, 'description');
  const subjectId = arg(argv, 'subject');
  const reason = arg(argv, 'reason');
  // YUK-1019 — 可选 --actor 让 owner 身份可追（默认 'owner-script' 已能区分
  // 脚本来源；传参用于区分具体操作人/批次）。
  const actor = arg(argv, 'actor');

  if (!rawSlug || !label) {
    console.error(
      'usage: tsx scripts/propose-cause-category.ts --slug <snake_case> --label <中文名> [--description <说明>] [--subject <profile-id>] [--reason <理由>] [--actor <owner-ref>]',
    );
    return 1;
  }
  const slug = sanitizeSlug(rawSlug);
  if (!slug) {
    console.error(`[propose-cause-category] slug "${rawSlug}" sanitizes to empty`);
    return 1;
  }

  const { db } = await import('@/db/client');
  const { resolveKnownSubjectId, resolveSubjectProfile } = await import('@/subjects/profile');
  const { writeAiProposal } = await import('@/kernel/proposals/writer');
  const { pendingProposalWithCooldown } = await import('@/kernel/proposals/inbox');
  const { CAUSE_OVERLAY_ID_PREFIX, getCauseCategoryOverlaysByIds } = await import(
    '@/capabilities/practice/server/cause-overlay'
  );
  const categoryId = `${CAUSE_OVERLAY_ID_PREFIX}${slug}`;

  const profile = resolveSubjectProfile(subjectId);
  if (subjectId && resolveKnownSubjectId(subjectId) === null) {
    // resolveSubjectProfile 对未知值静默回落 general——owner 明确传了 id 时
    // 必须 fail-loud 而不是悄悄写到别的科目词表上。
    console.error(`[propose-cause-category] unknown subject "${subjectId}"`);
    return 1;
  }

  if (profile.causeCategories.some((category) => category.id === categoryId)) {
    console.error(`[propose-cause-category] ${categoryId} already in ${profile.id} vocab`);
    return 1;
  }
  const existing = await getCauseCategoryOverlaysByIds(db, [categoryId]);
  if (existing.length > 0) {
    console.error(
      `[propose-cause-category] overlay row ${categoryId} already exists (status=${existing[0].status})`,
    );
    return 1;
  }

  const cooldownKey = `cause_category:${profile.id}`;
  if (await pendingProposalWithCooldown(db, 'cause_category', cooldownKey)) {
    console.error(
      `[propose-cause-category] a pending cause_category proposal for ${profile.id} already exists; decide it first`,
    );
    return 1;
  }

  const eventId = await writeAiProposal(db, {
    actor_ref: actor ?? 'owner-script',
    payload: {
      kind: 'cause_category',
      target: { subject_kind: 'subject_profile', subject_id: profile.id },
      reason_md: reason ?? `owner 手动提议错因类目 ${label}（${categoryId}）`,
      evidence_refs: [],
      cooldown_key: cooldownKey,
      proposed_change: {
        category_id: categoryId,
        label,
        ...(description ? { description } : {}),
        source: 'owner',
      },
    },
  });
  console.log(
    `[propose-cause-category] proposal written: event=${eventId} category=${categoryId} subject=${profile.id} — 收件箱 accept 后生效`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[propose-cause-category] failed:', error);
    process.exit(1);
  });
