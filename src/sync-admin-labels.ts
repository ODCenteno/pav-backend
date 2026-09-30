import type { Core } from '@strapi/strapi';

type FieldLabels = Record<string, string>;
type Attributes = Record<string, { description?: string }>;

interface FieldMetadata {
  edit: { label?: string; description?: string; [key: string]: unknown };
  list: { label?: string; [key: string]: unknown };
}

interface ViewConfiguration {
  settings: Record<string, unknown>;
  layouts: Record<string, unknown>;
  metadatas: Record<string, FieldMetadata>;
}

/**
 * Returns a copy of a Content Manager view configuration with the label (edit
 * and list views) and the help text of each labelled field set. The help text
 * comes from the schema attribute `description`; a field without one keeps
 * whatever description it already had. Every other setting is left untouched.
 */
export function applyFieldMetadata(
  configuration: ViewConfiguration,
  attributes: Attributes,
  labels: FieldLabels
): { configuration: ViewConfiguration; changed: boolean } {
  const metadatas: Record<string, FieldMetadata> = { ...configuration.metadatas };
  let changed = false;

  for (const [field, label] of Object.entries(labels)) {
    const current = metadatas[field];
    if (!current) continue;

    const description = attributes[field]?.description ?? current.edit.description;
    const next: FieldMetadata = {
      ...current,
      edit: { ...current.edit, label, description },
      list: { ...current.list, label },
    };

    if (
      current.edit.label !== label ||
      current.edit.description !== description ||
      current.list.label !== label
    ) {
      changed = true;
    }
    metadatas[field] = next;
  }

  return { configuration: { ...configuration, metadatas }, changed };
}

/**
 * Writes the Spanish field labels and help texts into the Content Manager
 * configuration of every content type and component in `labelsByUid`. Runs on
 * every boot and only writes the configurations that differ, so it is
 * idempotent. It overrides labels edited by hand in "Configure the view".
 */
export async function syncAdminLabels(
  strapi: Core.Strapi,
  labelsByUid: Record<string, FieldLabels>
): Promise<void> {
  const contentManager = strapi.plugin('content-manager');
  let updated = 0;

  for (const [uid, labels] of Object.entries(labelsByUid)) {
    const contentType = (strapi.contentTypes as Record<string, any>)[uid];
    const component = (strapi.components as Record<string, any>)[uid];
    const model = contentType ?? component;

    if (!model) {
      strapi.log.warn(`Admin labels: ${uid} is not a loaded content type or component; skipping`);
      continue;
    }

    const service = contentManager.service(contentType ? 'content-types' : 'components');
    const { settings, layouts, metadatas } = await service.findConfiguration(model);
    const { configuration, changed } = applyFieldMetadata(
      { settings, layouts, metadatas },
      model.attributes,
      labels
    );

    if (changed) {
      await service.updateConfiguration(model, configuration);
      updated += 1;
    }
  }

  if (updated > 0) {
    strapi.log.info(`Admin labels: updated ${updated} Content Manager configurations`);
  }
}
