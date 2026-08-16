import type { Core } from '@strapi/strapi';

/**
 * Shared-slug synchronization across locale variants.
 *
 * The `slug` field of these content types is intentionally NOT localized
 * (`pluginOptions.i18n.localized` absent): one slug must serve both
 * /sitios/<slug> and /en/sitios/<slug> so the frontend language switch
 * (built from a single slug) can never point at an unbuilt page (404).
 *
 * Strapi 5.39 only copies non-localized fields when a locale variant is
 * CREATED (i18n copyNonLocalizedAttributes). Updates write only the edited
 * variant's row, so the stored copies silently diverge (verified
 * empirically: an EN-tab slug update left every es-MX row untouched, and
 * publishing each locale kept different public slugs).
 *
 * This subscriber makes the sharing a storage-level invariant: whenever a
 * row of one of these models is updated, its slug is propagated to every
 * other row (draft and published, all locales) of the same document.
 */

export const SHARED_SLUG_MODELS = [
  'api::listing.listing',
  'api::category.category',
  'api::community-member.community-member',
  'api::legal-page.legal-page',
] as const;

type LifecycleEvent = {
  action: string;
  model?: { uid?: string };
  // Database-layer update params: { where, data, ... } (shape varies).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
};

export function isSharedSlugUpdate(action: string, uid: string | undefined): uid is string {
  return action === 'afterUpdate' && typeof uid === 'string' &&
    (SHARED_SLUG_MODELS as readonly string[]).includes(uid);
}

/**
 * Propagate the slug of the row(s) matched by `where` to every sibling row
 * of the same document. Returns the number of sibling rows corrected.
 */
export async function syncSharedSlugFor(
  strapi: Core.Strapi,
  uid: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: any
): Promise<number> {
  const rows = await strapi.db.query(uid).findMany({ where, select: ['documentId', 'slug'] });
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const slugByDoc = new Map<string, string>();
  for (const row of rows) {
    if (row?.documentId && typeof row.slug === 'string' && row.slug.length > 0) {
      slugByDoc.set(row.documentId, row.slug);
    }
  }

  let corrected = 0;
  for (const [documentId, slug] of slugByDoc) {
    const res = await strapi.db
      .query(uid)
      .updateMany({ where: { documentId, slug: { $ne: slug } }, data: { slug } });
    corrected += res?.count ?? 0;
  }
  return corrected;
}

/**
 * Register the db-lifecycle subscriber. Call once from bootstrap.
 */
export function subscribeSharedSlugSync(strapi: Core.Strapi): void {
  strapi.db.lifecycles.subscribe((event: LifecycleEvent) => {
    const uid = event?.model?.uid;
    if (!isSharedSlugUpdate(event?.action, uid)) return;
    syncSharedSlugFor(strapi, uid, event.params?.where).catch((e: Error) => {
      strapi.log.warn(`[shared-slug] sync failed for ${uid}: ${e?.message}`);
    });
  });
}
