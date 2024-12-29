import { getModel, getModelAttributes, isComponentAttribute, isDynamicZoneAttribute, isMediaAttribute, isRelationAttribute } from '../../utils/models';
import { getIdentifierField } from '../export/export-v3.js';
import { findOrImportFile } from './utils/file.js';
import { Struct, Schema, UID } from '@strapi/types';

interface ImportOptions {
  slug: string;
  user: any;
  allowDraftOnPublished?: boolean;
}

interface ImportFailure {
  error: Error;
  data: any;
}

interface ImportResult {
  failures: ImportFailure[];
}

interface LocaleVersions {
  [locale: string]: Record<string, any>;
}

interface EntryVersion {
  draft?: LocaleVersions;
  published?: LocaleVersions;
}

async function importDataV3(fileContent: { data: Record<UID.ContentType, EntryVersion[]> }, { 
  slug, 
  user,
  allowDraftOnPublished = true 
}: ImportOptions): Promise<ImportResult> {
  const { data } = fileContent;
  const failures: ImportFailure[] = [];

  for (const [contentType, entries] of Object.entries(data) as [UID.ContentType, EntryVersion[]][]) {
    const model = getModel(contentType);
    if (!model) {
      console.warn(`Model ${contentType} not found, skipping`);
      failures.push({ error: new Error(`Model ${contentType} not found`), data: contentType });
      continue;
    }

    const idField = getIdentifierField(model);

    // Import each entry's versions
    for (const entry of entries) {
      try {
        let documentId: string | null = null;

        // First handle published versions if they exist
        if (entry.published) {
          // Find the default locale version (usually 'en')
          const defaultLocale = Object.keys(entry.published)[0];
          const publishedData = entry.published[defaultLocale];
          
          // Look for existing entry using the default locale version
          const existing = await strapi.documents(contentType).findFirst({
            filters: { [idField]: publishedData[idField] }
          });

          const processedPublished = await processEntryData(publishedData, model, { user });

          if (existing) {
            await strapi.documents(contentType).update({
              documentId: existing.documentId,
              data: processedPublished,
              status: 'published'
            });
            documentId = existing.documentId;
          } else {
            const created = await strapi.documents(contentType).create({
              data: processedPublished,
              status: 'published'
            });
            documentId = created.documentId;
          }

          // Handle other locales for published version
          for (const [locale, localeData] of Object.entries(entry.published)) {
            if (locale === defaultLocale) continue;

            const processedLocale = await processEntryData(localeData, model, { user });
            await strapi.documents(contentType).update({
              documentId,
              locale,
              data: processedLocale,
              status: 'published'
            });
          }
        }

        // Then handle draft versions if they exist
        if (entry.draft) {
          // If we don't have a documentId yet (no published version), create from draft
          if (!documentId) {
            const defaultLocale = Object.keys(entry.draft)[0];
            const draftData = entry.draft[defaultLocale];
            const existing = await strapi.documents(contentType).findFirst({
              filters: { [idField]: draftData[idField] }
            });

            const processedDraft = await processEntryData(draftData, model, { user });

            if (existing) {
              if (!allowDraftOnPublished) {
                const existingPublished = await strapi.documents(contentType).findOne({
                  documentId: existing.documentId,
                  status: 'published'
                });

                if (existingPublished) {
                  failures.push({ 
                    error: new Error(`Cannot apply draft to existing published entry`), 
                    data: entry 
                  });
                  continue;
                }
              }

              await strapi.documents(contentType).update({
                documentId: existing.documentId,
                data: processedDraft,
                status: 'draft'
              });
              documentId = existing.documentId;
            } else {
              const created = await strapi.documents(contentType).create({
                data: processedDraft,
                status: 'draft'
              });
              documentId = created.documentId;
            }
          }

          // Handle all draft locales
          for (const [locale, localeData] of Object.entries(entry.draft)) {
            const processedLocale = await processEntryData(localeData, model, { user });
            await strapi.documents(contentType).update({
              documentId,
              locale,
              data: processedLocale,
              status: 'draft'
            });
          }
        }
      } catch (error) {
        console.error(`Failed to import entry`, error);
        failures.push({ error, data: entry });
      }
    }
  }

  return { failures };
}

async function processEntryData(entry, model: Struct.ContentTypeSchema | Struct.ComponentSchema, { user }) {
  const processed = { ...entry };

  for (const [key, attr] of Object.entries(model.attributes)) {
    if (!entry[key]) continue;

    if (key === 'localizations') {
      delete processed[key];
      continue;
    }

    if (isRelationAttribute(attr)) {
      processed[key] = await processRelation(entry[key], attr, { user });
    } else if (isComponentAttribute(attr)) {
      processed[key] = await processComponent(entry[key], attr, { user });
    } else if (isDynamicZoneAttribute(attr)) {
      processed[key] = await processDynamicZone(entry[key], { user });
    } else if (isMediaAttribute(attr)) {
      const allowedTypes = (attr as Schema.Attribute.Media).allowedTypes || ['any'];
      processed[key] = await processMedia(entry[key], { user }, allowedTypes);
    }
  }

  return processed;
}

async function processRelation(value, attr, { user }) {
  const relatedModel = getModel(attr.target);
  const relatedIdField = getIdentifierField(relatedModel);

  if (Array.isArray(value)) {
    const relations = [];
    for (const identifier of value) {
      const related = await strapi.documents(attr.target).findFirst({
        filters: { [relatedIdField]: identifier }
      });
      if (related) relations.push(related.id);
    }
    return relations;
  } else {
    const related = await strapi.documents(attr.target).findFirst({
      filters: { [relatedIdField]: value }
    });
    return related?.id || null;
  }
}

async function processComponent(value, attr, { user }) {
  if (Array.isArray(value)) {
    return Promise.all(value.map(item => processComponentItem(item, attr.component, { user })))
  }
  return processComponentItem(value, attr.component, { user });
}

async function processComponentItem(item, componentType, { user }) {
  const processed = { ...item };
  const componentModel = getModel(componentType);

  for (const [key, attr] of Object.entries(componentModel.attributes)) {
    if (!item[key]) continue;

    if (isMediaAttribute(attr)) {
      const allowedTypes = (attr as Schema.Attribute.Media).allowedTypes || ['any'];
      processed[key] = await processMedia(item[key], { user }, allowedTypes);
    } else if (isRelationAttribute(attr)) {
      processed[key] = await processRelation(item[key], attr, { user });
    }
  }

  return processed;
}

async function processDynamicZone(items, { user }) {
  return Promise.all(
    items.map(async item => ({
      __component: item.__component,
      ...(await processComponentItem(item, item.__component, { user }))
    }))
  );
}

async function processMedia(value, { user }, allowedTypes: string[] = ['any']) {
  if (Array.isArray(value)) {
    const media = [];
    for (const item of value) {
      console.log('Processing media URL:', item);
      const file = await findOrImportFile(item, user, { allowedFileTypes: allowedTypes });
      if (file) media.push(file.id);
    }
    return media;
  } else {
    const file = await findOrImportFile(value, user, { allowedFileTypes: allowedTypes });
    return file?.id || null;
  }
}

export {
  importDataV3
}; 