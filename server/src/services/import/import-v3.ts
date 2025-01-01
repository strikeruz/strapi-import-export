import { getModel, getModelAttributes, isComponentAttribute, isDynamicZoneAttribute, isMediaAttribute, isRelationAttribute } from '../../utils/models';
import { getIdentifierField } from '../export/export-v3';
import { findOrImportFile } from './utils/file';
import { Struct, Schema, UID } from '@strapi/types';
import { FileContent, validateFileContent } from './validation';
import { ImportContext } from './utils/import-context';
import { ImportProcessor } from './utils/import-processor';

export enum ExistingAction {
    Warn = 'warn',
    Update = 'update',
    Skip = 'skip'
}

interface ImportOptions {
    slug: string;
    user: any;
    allowDraftOnPublished?: boolean;
    existingAction?: ExistingAction;
    ignoreMissingRelations?: boolean;
    allowLocaleUpdates?: boolean;
    disallowNewRelations?: boolean;
}

export interface ImportFailure {
    error: string;
    data: any;
}

export interface ImportError {
    error: string;
    data: {
        entry: any;
        path: string;
    };
}

export interface ImportResult {
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

interface ProcessedEntry {
  contentType: UID.ContentType;
  idFieldValue: any;
  documentId: string;
}

function sanitizeData(data: any, model: Schema.Schema): any {
  if (!data || typeof data !== 'object') return data;
  
  console.log(`\nSanitizing data for model: ${model.uid}`);
  const sanitized = { ...data };
  const validAttributes = Object.entries(model.attributes)
    .filter(([_, attr]) => attr.configurable !== false);
  const validAttributeNames = new Set(validAttributes.map(([name]) => name));

  console.log('Valid attribute names:', Array.from(validAttributeNames));

  // Remove any fields that aren't in the model
  for (const key of Object.keys(sanitized)) {
    if (!validAttributeNames.has(key)) {
      console.log(`Removing field '${key}' from ${model.uid} - not in model or not configurable`);
      delete sanitized[key];
      continue;
    }

    const attr = model.attributes[key];
    console.log(`Processing field '${key}' of type ${attr.type}`);
    
    // Recursively sanitize components
    if (isComponentAttribute(attr)) {
      if (Array.isArray(sanitized[key])) {
        console.log(`Sanitizing repeatable component array for '${key}'`);
        sanitized[key] = sanitized[key].map((item, index) => {
          console.log(`Sanitizing component item ${index} in '${key}'`);
          return sanitizeData(item, getModel(attr.component));
        });
      } else if (sanitized[key]) {
        console.log(`Sanitizing single component for '${key}'`);
        sanitized[key] = sanitizeData(sanitized[key], getModel(attr.component));
      }
    }
    // Recursively sanitize dynamic zones
    else if (isDynamicZoneAttribute(attr)) {
      if (Array.isArray(sanitized[key])) {
        console.log(`Sanitizing dynamic zone array for '${key}'`);
        sanitized[key] = sanitized[key].map((item, index) => {
          if (!item.__component) {
            console.log(`Skipping dynamic zone item ${index} - missing __component`);
            return null;
          }
          console.log(`Sanitizing dynamic zone item ${index} of type ${item.__component}`);
          const componentModel = getModel(item.__component);
          return {
            __component: item.__component,
            ...sanitizeData(item, componentModel)
          };
        }).filter(Boolean);
      }
    }
    else if (isRelationAttribute(attr)) {
      if (Array.isArray(sanitized[key])) {
        const originalLength = sanitized[key].length;
        sanitized[key] = sanitized[key].filter(id => id != null);
        if (sanitized[key].length !== originalLength) {
          console.log(`Filtered out ${originalLength - sanitized[key].length} null relations from '${key}'`);
        }
      }
    }
  }

  console.log(`Finished sanitizing ${model.uid}`);
  return sanitized;
}

async function importVersionData(
  contentType: UID.ContentType,
  versionData: LocaleVersions,
  model: Schema.Schema,
  processedEntries: ProcessedEntry[],
  failures: ImportFailure[],
  options: {
    documentId?: string | null,
    status: 'draft' | 'published',
    idField: string,
    user: any,
    allowDraftOnPublished?: boolean,
    existingAction: ExistingAction,
    importData?: Record<UID.ContentType, EntryVersion[]>
  }
): Promise<string> {
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

    const processedData = await processEntryData(firstData, model, failures, processedEntries, { 
      user: options.user, 
      allowDraftOnPublished: options.allowDraftOnPublished, 
      existingAction: options.existingAction,
      importData: options.importData || {} 
    });

    // Sanitize data just before create/update
    const sanitizedData = sanitizeData(processedData, model);

    if (existing) {
        switch (options.existingAction) {
            case ExistingAction.Skip:
                console.log(`Skipping existing entry with ${options.idField}=${firstData[options.idField]}`);
                return existing.documentId;

            case ExistingAction.Update:
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
                        return null;
                    }
                }

                await strapi.documents(contentType).update({
                    documentId: existing.documentId,
                    locale: firstLocale === 'default' ? undefined : firstLocale,
                    data: sanitizedData,
                    status: options.status
                });
                documentId = existing.documentId;
                processedFirstLocale = true;
                break;

            case ExistingAction.Warn:
            default:
                failures.push({ 
                    error: `Entry with ${options.idField}=${firstData[options.idField]} already exists`, 
                    data: versionData 
                });
                return null;
        }
    } else {
      const created = await strapi.documents(contentType).create({
        data: sanitizedData,
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
    const processedLocale = await processEntryData(localeData, model, failures, processedEntries, { 
      user: options.user, 
      allowDraftOnPublished: options.allowDraftOnPublished, 
      existingAction: options.existingAction,
      importData: options.importData || {} 
    });

    // Sanitize locale data before update
    const sanitizedLocaleData = sanitizeData(processedLocale, model);

    await strapi.documents(contentType).update({
      documentId,
      locale: locale === 'default' ? undefined : locale,
      data: sanitizedLocaleData,
      status: options.status
    });
  }

  return documentId;
}

async function importDataV3(fileContent: FileContent, { 
    slug, 
    user,
    allowDraftOnPublished = true,
    existingAction = ExistingAction.Warn,
    ignoreMissingRelations = false,
    allowLocaleUpdates = false,
    disallowNewRelations = true
}: ImportOptions): Promise<ImportResult> {
    // validate file content
    if (!fileContent.data) {
        console.log('No data found in file');
        throw new Error('No data found in file');
    }

    const validationResult = await validateFileContent(fileContent, { 
        existingAction,
        ignoreMissingRelations 
    });
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

    // Create context and processor
    const context = new ImportContext(
        {
            existingAction,
            allowDraftOnPublished,
            ignoreMissingRelations,
            allowLocaleUpdates,
            disallowNewRelations
        },
        fileContent.data,
        user
    );

    const processor = new ImportProcessor(context, {
        documents: strapi.documents
    });

    // Process the import
    return processor.process();
}

async function processEntry(
  contentType: UID.ContentType,
  entry: EntryVersion,
  model: Schema.Schema,
  idField: string,
  user: any,
  allowDraftOnPublished: boolean,
  existingAction: ExistingAction,
  processedEntries: ProcessedEntry[],
  failures: ImportFailure[],
  data: Record<UID.ContentType, EntryVersion[]>
) {
  let documentId: string | null = null;

  // First handle published versions if they exist
  if (entry.published) {
    documentId = await importVersionData(contentType, entry.published, model, processedEntries, failures, {
      status: 'published',
      idField,
      user,
      allowDraftOnPublished,
      importData: data,
      existingAction
    });
    
    if (documentId) {
      // Track this processed entry
      processedEntries.push({
        contentType,
        idFieldValue: entry.published.default[idField],
        documentId
      });
    }
  }

  // Then handle draft versions if they exist
  if (entry.draft) {
    documentId = await importVersionData(contentType, entry.draft, model, processedEntries, failures, {
      documentId,
      status: 'draft',
      idField,
      user,
      allowDraftOnPublished,
      importData: data,
      existingAction
    });
  }

  return documentId;
}

async function processRelation(
    relationValue: any,
    attr: Schema.Attribute.RelationWithTarget,
    processedEntries: ProcessedEntry[],
    failures: ImportFailure[],
    options: {
        user: any;
        allowDraftOnPublished: boolean;
        existingAction: ExistingAction;
        importData: Record<UID.ContentType, EntryVersion[]>;
    }
): Promise<string | null> {
    const targetModel = getModel(attr.target);
    const targetIdField = getIdentifierField(targetModel);

    // Check if this relation has already been processed
    const processed = processedEntries.find(entry => 
        entry.contentType === attr.target && 
        entry.idFieldValue === relationValue
    );
    
    if (processed) {
        return processed.documentId;
    }

    // Look for the target in import data first
    if (options.importData[attr.target]) {
        const targetEntry = findEntryInImportData(
            relationValue,
            targetIdField,
            options.importData[attr.target]
        );

        if (targetEntry) {
            // If we found an entry, check if it has both draft and published versions
            const publishedIdValue = targetEntry.published?.default?.[targetIdField];
            const draftIdValue = targetEntry.draft?.default?.[targetIdField];

            if (publishedIdValue && draftIdValue && publishedIdValue !== draftIdValue) {
                // If the values are different, we need to look up the published version in the database
                const dbRecord = await findInDatabase(publishedIdValue, targetModel, targetIdField);
                if (dbRecord) {
                    return dbRecord.documentId;
                }
            }

            // If we're here, either:
            // 1. The entry only has one version
            // 2. Both versions have the same idValue
            // 3. We couldn't find the published version in the database
            // So process the entry
            if (attr.relation === 'oneWay' || attr.relation === 'manyWay') {
                console.log(`Processing related entry from import data: ${attr.target} ${relationValue}`);
                return await processEntry(
                    attr.target,
                    targetEntry,
                    targetModel,
                    targetIdField,
                    options.user,
                    options.allowDraftOnPublished,
                    options.existingAction,
                    processedEntries,
                    failures,
                    options.importData
                );
            }
        }
    }

    // If not found in import data or not processable, look in database
    const dbRecord = await findInDatabase(relationValue, targetModel, targetIdField);
    if (dbRecord) {
        return dbRecord.documentId;
    }

    return null;
}

async function findInDatabase(
    idValue: any,
    targetModel: Schema.Schema,
    targetIdField: string
): Promise<{ documentId: string } | null> {
    // Check both published and draft versions
    const publishedVersion = await strapi.documents(targetModel.uid as UID.ContentType).findFirst({
        filters: { [targetIdField]: idValue },
        status: 'published'
    });

    const draftVersion = await strapi.documents(targetModel.uid as UID.ContentType).findFirst({
        filters: { [targetIdField]: idValue },
        status: 'draft'
    });

    if (publishedVersion && draftVersion) {
        if (publishedVersion.documentId === draftVersion.documentId) {
            return publishedVersion;
        }
        console.warn(`Found both published and draft versions with different documentIds for ${targetModel.uid} ${idValue}. Using published version.`);
        return publishedVersion;
    }

    return publishedVersion || draftVersion;
}

function findEntryInImportData(
    relationValue: any,
    targetIdField: string,
    targetEntries: EntryVersion[]
): EntryVersion | null {
    return targetEntries.find(entry => {
        // Check draft version first as it might be the intended target
        if (entry.draft) {
            const draftMatch = Object.values(entry.draft).some(
                localeData => localeData[targetIdField] === relationValue
            );
            if (draftMatch) return true;
        }
        // Then check published version
        if (entry.published) {
            return Object.values(entry.published).some(
                localeData => localeData[targetIdField] === relationValue
            );
        }
        return false;
    }) || null;
}

async function processEntryData(
  data: any, 
  model: Schema.Schema, 
  failures: ImportFailure[], 
  processedEntries: ProcessedEntry[], 
  options: {
    user: any;
    allowDraftOnPublished: boolean;
    existingAction: ExistingAction;
    importData?: Record<UID.ContentType, EntryVersion[]>;
}) {
  const processed = { ...data };

  for (const [key, attr] of Object.entries(model.attributes)) {
    if (!data[key]) continue;

    if (key === 'localizations') {
      delete processed[key];
      continue;
    }

    if (isRelationAttribute(attr)) {
      if (Array.isArray(data[key])) {
        const documentIds = await Promise.all(
          data[key].map(value => 
            processRelation(value, attr, processedEntries, failures, {
              user: options.user,
              importData: options.importData || {},
              allowDraftOnPublished: options.allowDraftOnPublished,
              existingAction: options.existingAction
            })
          )
        );
        processed[key] = documentIds.filter(id => id !== null);
      } else {
        const documentId = await processRelation(data[key], attr, processedEntries, failures, {
          user: options.user,
          importData: options.importData || {},
          allowDraftOnPublished: options.allowDraftOnPublished,
          existingAction: options.existingAction
        });
        processed[key] = documentId;
      }
    } else if (isComponentAttribute(attr)) {
      processed[key] = await processComponent(data[key], attr, processedEntries, failures, {
        user: options.user,
        allowDraftOnPublished: options.allowDraftOnPublished,
        importData: options.importData || {},
        existingAction: options.existingAction
      });
    } else if (isDynamicZoneAttribute(attr)) {
      processed[key] = await processDynamicZone(data[key], processedEntries, failures, { 
        user: options.user, 
        importData: options.importData, 
        allowDraftOnPublished: options.allowDraftOnPublished,
        existingAction: options.existingAction
      });
    } else if (isMediaAttribute(attr)) {
      const allowedTypes = (attr as Schema.Attribute.Media).allowedTypes || ['any'];
      processed[key] = await processMedia(data[key], { user: options.user }, allowedTypes);
    }
  }

  return processed;
}

async function processComponent(
  value, 
  attr, 
  processedEntries: ProcessedEntry[],
  failures: ImportFailure[],
  options: {
    user: any;
    allowDraftOnPublished: boolean;
    existingAction: ExistingAction;
    importData?: Record<UID.ContentType, EntryVersion[]>;
}) {
  if (Array.isArray(value)) {
    return Promise.all(value.map(item => processComponentItem(item, attr.component, processedEntries, failures, { 
      user: options.user, 
      importData: options.importData, 
      allowDraftOnPublished: options.allowDraftOnPublished, 
      existingAction: options.existingAction 
    })))
  }
  return processComponentItem(value, attr.component, processedEntries, failures, { 
    user: options.user, 
    importData: options.importData, 
    allowDraftOnPublished: options.allowDraftOnPublished,
    existingAction: options.existingAction
  });
}

async function processComponentItem(
  item, 
  componentType,
  processedEntries: ProcessedEntry[],
  failures: ImportFailure[],
  options: {
    user: any;
    importData?: Record<UID.ContentType, EntryVersion[]>;
    allowDraftOnPublished: boolean;
    existingAction: ExistingAction;
}) {
  const processed = { ...item };
  const componentModel = getModel(componentType);

  for (const [key, attr] of Object.entries(componentModel.attributes)) {
    if (!item[key]) continue;

    if (isMediaAttribute(attr)) {
      const allowedTypes = (attr as Schema.Attribute.Media).allowedTypes || ['any'];
      processed[key] = await processMedia(item[key], { user: options.user }, allowedTypes);
    } else if (isRelationAttribute(attr)) {
      processed[key] = await processRelation(item[key], attr, processedEntries, failures, {
        user: options.user,
        importData: options.importData,
        allowDraftOnPublished: options.allowDraftOnPublished,
        existingAction: options.existingAction
      });
    }
  }

  return processed;
}

async function processDynamicZone(items, processedEntries: ProcessedEntry[], failures: ImportFailure[], options: { user: any, importData?: Record<UID.ContentType, EntryVersion[]>, allowDraftOnPublished: boolean, existingAction: ExistingAction }) {
  return Promise.all(
    items.map(async item => ({
      __component: item.__component,
      ...(await processComponentItem(item, item.__component, processedEntries, failures, { 
        user: options.user, 
        importData: options.importData, 
        allowDraftOnPublished: options.allowDraftOnPublished, 
        existingAction: options.existingAction 
      }))
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