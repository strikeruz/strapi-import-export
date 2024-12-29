import { getModel, getModelAttributes, isComponentAttribute, isDynamicZoneAttribute, isMediaAttribute, isRelationAttribute } from '../../utils/models';
import { getIdentifierField } from '../export/export-v3.js';
import { findOrImportFile } from './utils/file.js';
import { Struct, Schema, UID } from '@strapi/types';
import { FileContent, validateFileContent } from './validation';

interface ImportOptions {
  slug: string;
  user: any;
  allowDraftOnPublished?: boolean;
}

interface ImportFailure {
  error: string;
  data: any;
}

interface ImportError {
  error: string;
  data: {
    entry: any;
    path: string;
  };
}

interface ImportResult {
  failures?: ImportFailure[];
  errors?: ImportError[];
}

export interface LocaleVersions {
  [locale: string]: Record<string, any>;
}

export interface EntryVersion {
  draft?: LocaleVersions;
  published?: LocaleVersions;
}

async function importVersionData(
  contentType: UID.ContentType,
  versionData: LocaleVersions,
  model: Schema.Schema,
  options: {
    documentId?: string | null,
    status: 'draft' | 'published',
    idField: string,
    user: any,
    allowDraftOnPublished?: boolean
  }
): Promise<{ documentId: string; failures: ImportFailure[] }> {
  const failures: ImportFailure[] = [];
  let { documentId } = options;
  let processedFirstLocale = false;

  // Determine which locale to process first, prioritizing 'default' if it exists
  const locales = Object.keys(versionData);
  const firstLocale = locales.includes('default') ? 'default' : locales[0];
  const firstData = versionData[firstLocale];

  if (!documentId) {
    // Look for existing entry
    const existing = await strapi.documents(contentType).findFirst({
      filters: { [options.idField]: firstData[options.idField] }
    });

    const processedData = await processEntryData(firstData, model, { user: options.user });

    if (existing) {
      if (options.status === 'draft' && !options.allowDraftOnPublished) {
        const existingPublished = await strapi.documents(contentType).findOne({
          documentId: existing.documentId,
          status: 'published'
        });

        if (existingPublished) {
          failures.push({ 
            error: `Cannot apply draft to existing published entry`, 
            data: versionData 
          });
          return { documentId: null, failures };
        }
      }

      await strapi.documents(contentType).update({
        documentId: existing.documentId,
        locale: firstLocale === 'default' ? undefined : firstLocale,
        data: processedData,
        status: options.status
      });
      documentId = existing.documentId;
      processedFirstLocale = true;
    } else {
      const created = await strapi.documents(contentType).create({
        data: processedData,
        status: options.status,
        locale: firstLocale === 'default' ? undefined : firstLocale,
      });
      documentId = created.documentId;
      processedFirstLocale = true;
    }
  }

  // Handle all locales (only skip first if we just processed it)
  for (const locale of locales) {
    if (processedFirstLocale && locale === firstLocale) continue;

    const localeData = versionData[locale];
    const processedLocale = await processEntryData(localeData, model, { user: options.user });
    await strapi.documents(contentType).update({
      documentId,
      locale: locale === 'default' ? undefined : locale,
      data: processedLocale,
      status: options.status
    });
  }

  return { documentId, failures };
}

async function importDataV3(fileContent: FileContent, { 
  slug, 
  user,
  allowDraftOnPublished = true 
}: ImportOptions): Promise<ImportResult> {

  // validate file content
  if (!fileContent.data) {
    console.log('No data found in file');
    throw new Error('No data found in file');
  }

  const validationResult = await validateFileContent(fileContent);
  if (!validationResult.isValid) {
    return {
      errors: validationResult.errors.map(error => {
        console.log('Validation failed', JSON.stringify(error, null, 2));
        return {
          error: error.message,
          data: {
            entry: error.entry,
            path: error.path ? error.path.join('.') : undefined
          }
        }
      })
    };
  }
  
  const { data } = fileContent;
  const failures: ImportFailure[] = [];

  for (const [contentType, entries] of Object.entries(data) as [UID.ContentType, EntryVersion[]][]) {
    const model = getModel(contentType);
    if (!model) {
      console.warn(`Model ${contentType} not found, skipping`);
      failures.push({ error: `Model ${contentType} not found`, data: contentType });
      continue;
    }

    const idField = getIdentifierField(model);

    // Import each entry's versions
    for (const entry of entries) {
      try {
        let documentId: string | null = null;

        // First handle published versions if they exist
        if (entry.published) {
          const result = await importVersionData(contentType, entry.published, model, {
            status: 'published',
            idField,
            user
          });
          documentId = result.documentId;
          failures.push(...result.failures);
        }

        // Then handle draft versions if they exist
        if (entry.draft) {
          const result = await importVersionData(contentType, entry.draft, model, {
            documentId,
            status: 'draft',
            idField,
            user,
            allowDraftOnPublished
          });
          failures.push(...result.failures);
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