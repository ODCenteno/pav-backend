# I18N Component Bilingual-Field Pattern — Documentation

**File:** `docs/I18N-COMPONENT-PATTERN.md`
**Context:** Strapi v5 · `pav-backend` · Localized listing content types
**Status: Known UX issue — fix is deferred pending decision**

---

## 1. The Pattern — Paired `_es` / `_en` Suffix Fields

Four Strapi components use a **paired bilingual-field pattern** instead of Strapi's built-in i18n localization. Each component has two parallel fields (one per language) as siblings within the same attribute:

```json
// src/components/tag/tag-item.json
{
  "attributes": {
    "label_es": { "type": "string", "required": true },
    "label_en": { "type": "string" }
  }
}
```

### Affected components

| Component | File | Fields |
|---|---|---|
| `tag.tag-item` | `src/components/tag/tag-item.json` | `label_es`, `label_en` |
| `schedule.hours` | `src/components/schedule/hours.json` | `text_es`, `text_en` |
| `recommendation.visit-info` | `src/components/recommendation/visit-info.json` | `bestTime_es/en`, `bring_es/en`, `accessibilityNotes_es/en`, `connectivityNotes_es/en` |
| `common.localized-text` | `src/components/common/localized-text.json` | `text_es`, `text_en` |

### Where they are used

| Listing attribute | Component type | I18n on attribute? |
|---|---|---|
| `tags` | `tag.tag-item` (repeatable) | `pluginOptions.i18n.localized: true` |
| `amenities` | `tag.tag-item` (repeatable) | `pluginOptions.i18n.localized: true` |
| `schedule` | `schedule.hours` | `pluginOptions.i18n.localized: true` |
| `recommendations` | `recommendation.visit-info` | `pluginOptions.i18n.localized: true` |

> The `pluginOptions.i18n.localized: true` on the parent attribute means "this entire component is localized per locale." It does **not** affect the internal `_es`/`_en` field pairing within the component.

---

## 2. Why This Pattern Was Chosen

1. **Spanish is the source of truth.** `label_es` is `required: true`; `label_en` is optional.
2. **Frontend fallback is built-in.** `strapiTransformer.ts:415-418` reads `label_en ?? label_es`, so missing English values gracefully fall back to Spanish.
3. **Fewer locale switches for editors.** Editors fill both language versions of a field in one place without toggling the locale picker.
4. **No nested i18n complexity.** Components with i18n-localized fields are complex to populate and debug in Strapi v5's document service.

---

## 3. The UX Problem in the Admin UI

When a content editor opens a listing in the Strapi admin panel and selects **English (en)** from the locale picker at the top, they see:

- ✅ `title` → shows the English version only (this field IS properly i18n-localized)
- ❌ `tags` → shows **both** `label_es` AND `label_en` inputs
- ❌ `amenities` → shows both `label_es` AND `label_en` inputs
- ❌ `schedule` → shows both `text_es` AND `text_en` inputs
- ❌ `recommendations` → shows all 8 fields: `bestTime_es`, `bestTime_en`, `bring_es`, `bring_en`, `accessibilityNotes_es`, `accessibilityNotes_en`, `connectivityNotes_es`, `connectivityNotes_en`

**The problem:** The editor must manually ignore the `_es` fields when editing the English version and vice versa. This is confusing, error-prone, and inconsistent with how `title`, `shortDescription`, and `description` already work (those fields are properly i18n-localized and show only the relevant locale in each view).

---

## 4. Frontend Transformer Compatibility

The frontend at `pav-frontend/src/utils/strapiTransformer.ts` already handles **both** the old paired-field shape AND the standard i18n shape:

```typescript
// Line 415-418 — localeSuffixed helper reads label_es / label_en
function localeSuffixed(obj: any, key: string): LocalizedString | undefined {
  const es = obj[`${key}_es`];
  const en = obj[`${key}_en`] ?? es;
  if (es == null && en == null) return undefined;
  return { 'es-MX': String(es ?? ''), en: String(en ?? '') };
}

// Line 391-401 — localized() reads { 'es-MX': ..., en: ... } shapes
function localized(value: ..., locale: string = 'es-MX'): LocalizedString {
  if (value && typeof value === 'object') {
    return { 'es-MX': (value as any)['es-MX'] || (value as any).es || '', en: (value as any).en || '' };
  }
  // ...
}
```

So the frontend is agnostic to which approach is used. Any fix to the schema is purely a backend/admin-UI concern.

---

## 5. Fix Options

### Option A — Convert to native i18n-localized fields ✅ Recommended

**Change:** Replace each paired `_es`/`_en` field pair with a single field marked `pluginOptions.i18n.localized: true`.

```json
// Before (tag-item)
{ "label_es": { "type": "string" }, "label_en": { "type": "string" } }

// After (tag-item)
{ "label": { "type": "string", "pluginOptions": { "i18n": { "localized": true } } } }
```

**Steps:**
1. Update `src/components/tag/tag-item.json`, `src/components/schedule/hours.json`, `src/components/recommendation/visit-info.json`, `src/components/common/localized-text.json`
2. Remove `pluginOptions.i18n.localized: true` from the parent listing attribute (since the field itself is now localized)
3. Write an idempotent migration in `src/index.ts bootstrap()` that transforms existing `{ label_es, label_en }` → `{ label: { "es-MX": esValue, en: enValue } }` on all component instances in the DB
4. Update `strapiTransformer.ts` `localeSuffixed()` helper to read the new single-field shape (or keep the helper for backward compat during migration)
5. Test locally with the existing SQLite data

**Pros:** Cleanest model. Consistent with `title`, `shortDescription`, `description`. No admin UI custom code.

**Cons:** Schema migration required. Must deploy migration before frontend code (staged deploy).

---

### Option B — Custom admin UI input component (UI isolation)

**Change:** Create a custom Strapi admin component at `src/admin/components/BilingualField.tsx` that conditionally renders only the field matching the active locale. Register it as an override for these field types.

**Pros:** No schema changes. No data migration. Backward-compatible.

**Cons:** Custom admin code must be maintained across Strapi upgrades. Still architecturally inconsistent with the rest of the content types.

---

### Option C — Visual locale badges (zero code change)

**Change:** No code. Add a `README.md` note or in-app tooltip explaining the paired-field pattern to content editors.

**Pros:** Zero risk.

**Cons:** Does not fix the UX confusion.

---

### Option D — Status quo (no action)

**Change:** None. Document the pattern and defer the fix to a later iteration.

---

## 6. Recommended Next Step

**Option A** is the architecturally correct fix and should be implemented when the team has bandwidth for a staged deployment (migration first, then frontend update). Assign to the next sprint.

If a faster fix is needed now, **Option B** addresses the UX pain without touching schemas or data.

---

## 7. Related Files

| File | Role |
|---|---|
| `src/components/tag/tag-item.json` | `tags` and `amenities` component |
| `src/components/schedule/hours.json` | `schedule` component |
| `src/components/recommendation/visit-info.json` | `recommendations` component |
| `src/components/common/localized-text.json` | Shared bilingual text component |
| `src/api/listing/content-types/listing/schema.json` | Listing schema (parent attributes) |
| `src/index.ts` | Bootstrap — migration hook (add migration here for Option A) |
| `pav-frontend/src/utils/strapiTransformer.ts:415-445` | `localeSuffixed()` helper — handles both old and new shapes |
| `pav-frontend/src/utils/strapiTransformer.ts:391-401` | `localized()` helper — handles both shapes |

---

*Last updated: 2026-08-02*
