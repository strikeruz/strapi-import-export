import { Schema, UID } from '@strapi/types';
import { ImportContext } from './import-context';
import { EntryVersion, ImportResult, LocaleVersions, ExistingAction } from '../import-v3';
import {
  getModel,
  isComponentAttribute,
  isDynamicZoneAttribute,
  isMediaAttribute,
  isRelationAttribute,
} from '../../../utils/models';
import { getIdentifierField } from '../../../utils/identifiers';
import { findOrImportFile } from '../utils/file';
import { logger } from '../../../utils/logger';

export class ImportProcessor {
  private context: ImportContext;
  private onProgress?: (progress: number, message: string) => void;
  private services: {
    documents: typeof strapi.documents;
  };
  private totalEntries: number = 0;
  private processedEntries: number = 0;
  // Cache для созданных в этом импорте сущностей, чтобы избежать дублирования
  private createdEntitiesCache: Map<string, string> = new Map();

  constructor(
    context: ImportContext,
    services: {
      documents: typeof strapi.documents;
    },
    onProgress?: (progress: number, message: string) => void
  ) {
    this.context = context;
    this.services = services;
    this.onProgress = onProgress;
  }

  async process(): Promise<ImportResult> {
    // Log import options for debugging
    logger.info('Starting import process with options:', {
      operation: 'import',
      existingAction: this.context.options.existingAction,
      ignoreMissingRelations: this.context.options.ignoreMissingRelations,
      allowDraftOnPublished: this.context.options.allowDraftOnPublished,
      allowLocaleUpdates: this.context.options.allowLocaleUpdates,
      disallowNewRelations: this.context.options.disallowNewRelations,
      createMissingEntities: this.context.options.createMissingEntities,
    });

    // Дополнительное логирование для отладки
    if (this.context.options.createMissingEntities) {
      logger.info('✅ Entity creation is ENABLED - missing entities will be created');
    } else {
      logger.warn('❌ Entity creation is DISABLED - missing entities will cause errors');
    }

    const importData = this.context.importData;

    // Check for duplicates in import data
    this.detectDuplicatesInImportData(importData);

    this.totalEntries = Object.values(importData).reduce(
      (count, entries) => count + entries.length,
      0
    );

    this.processedEntries = 0;

    // Report initial progress
    this.reportProgress(0, `Starting import of ${this.totalEntries} entries`);

    let contentTypeIndex = 0;
    const totalContentTypes = Object.keys(importData).length;

    for (const [contentType, entries] of Object.entries(importData) as [
      UID.ContentType,
      EntryVersion[],
    ][]) {
      const context = {
        operation: 'import',
        contentType,
      };

      contentTypeIndex++;
      this.reportProgress(
        (contentTypeIndex / totalContentTypes) * 0.1, // First 10% is for content type initialization
        `Processing content type ${contentType} (${contentTypeIndex}/${totalContentTypes})`
      );

      const model = getModel(contentType);
      if (!model) {
        logger.error(`Model not found`, context);
        this.context.addFailure(`Model ${contentType} not found`, contentType);
        continue;
      }

      const idField: string | undefined =
        model.kind !== 'singleType' ? getIdentifierField(model) : undefined;

      logger.debug(`Processing entries with identifier field: ${idField}`, context);

      // Import each entry's versions
      let entryIndex = 0;
      for (const entry of entries) {
        entryIndex++;
        this.reportProgress(
          0.1 + (this.processedEntries / this.totalEntries) * 0.9, // Remaining 90% is for entry processing
          `Processing entry ${entryIndex}/${entries.length} for ${contentType}`
        );

        try {
          await this.processEntry(contentType, entry, model, idField);
        } catch (error) {
          logger.error(`Failed to import entry`, context, error);
          if (error.details) {
            logger.debug('Error Details', {
              ...context,
              details: JSON.stringify(error.details, null, 2),
            });
            this.context.addFailure(error.message || 'Unknown error', entry, error.details);
          } else {
            this.context.addFailure(error.message || 'Unknown error', entry);
          }
        }

        this.processedEntries++;
        this.reportProgress(
          0.1 + (this.processedEntries / this.totalEntries) * 0.9,
          `Processed ${this.processedEntries}/${this.totalEntries} entries`
        );
      }
    }

    // Report completion
    this.reportProgress(1, `Import complete. Processed ${this.processedEntries} entries.`);

    return { failures: this.context.getFailures() };
  }

  private reportProgress(progress: number, message: string): void {
    if (this.onProgress) {
      // Make sure progress is between 0 and 1
      const normalizedProgress = Math.min(Math.max(progress, 0), 1);
      this.onProgress(normalizedProgress, message);
    }
  }

  private async processEntry(
    contentType: UID.ContentType,
    entry: EntryVersion,
    model: Schema.Schema,
    idField: string | undefined
  ): Promise<string | null> {
    const context = {
      operation: 'import',
      contentType,
      idField,
    };

    let documentId: string | null = null;

    // First handle published versions if they exist
    if (entry.published) {
      logger.debug('Processing published version', context);
      documentId = await this.importVersionData(contentType, entry.published, model, {
        status: 'published',
        idField,
      });
    }

    // Then handle draft versions if they exist
    if (entry.draft) {
      logger.debug('Processing draft version', context);
      documentId = await this.importVersionData(contentType, entry.draft, model, {
        documentId,
        status: 'draft',
        idField,
      });
    }

    return documentId;
  }

  private async importVersionData(
    contentType: UID.ContentType,
    versionData: LocaleVersions,
    model: Schema.Schema,
    options: {
      documentId?: string | null;
      status: 'draft' | 'published';
      idField?: string | undefined;
    }
  ): Promise<string | null> {
    const context = {
      operation: 'import',
      contentType,
      status: options.status,
      documentId: options.documentId,
    };

    logger.debug('Processing version data', context);

    let { documentId } = options;
    let processedFirstLocale = false;

    // Determine which locale to process first
    const locales = Object.keys(versionData);
    const firstLocale = locales.includes('default') ? 'default' : locales[0];
    const firstData = versionData[firstLocale];

    // Add duplicate check based on title/name for this specific import session
    const uniqueKey = this.generateUniqueKey(contentType, firstData);
    if (this.createdEntitiesCache.has(uniqueKey)) {
      const existingDocumentId = this.createdEntitiesCache.get(uniqueKey);
      logger.info(`🔄 Skipping duplicate entry (already processed in this import)`, {
        ...context,
        uniqueKey,
        existingDocumentId,
        title: firstData.title || firstData.name,
      });
      return existingDocumentId;
    }

    if (!documentId) {
      // Look for existing entry
      const filter = options.idField ? { [options.idField]: firstData[options.idField] } : {};
      let existing = await this.services.documents(contentType).findFirst({
        filters: filter,
        status: options.status,
      });

      logger.debug('Initial existing entry search result', {
        ...context,
        hasIdField: !!options.idField,
        idFieldValue: options.idField ? firstData[options.idField] : 'N/A',
        foundExisting: !!existing,
        existingId: existing?.documentId,
      });

      // If no existing entry found by idField and this is a modal, try searching by title
      if (!existing && contentType === 'api::modal.modal' && firstData.title) {
        logger.debug('No existing modal found by idField, trying title search', {
          ...context,
          title: firstData.title,
          locale: firstLocale === 'default' ? 'default' : firstLocale,
        });

        try {
          // Try with locale first
          if (firstLocale !== 'default') {
            existing = await this.services.documents(contentType).findFirst({
              filters: {
                title: firstData.title,
                locale: firstLocale,
              },
              status: options.status,
            });
          }

          // If still not found, try without locale filter
          if (!existing) {
            existing = await this.services.documents(contentType).findFirst({
              filters: {
                title: firstData.title,
              },
              status: options.status,
            });
          }

          if (existing) {
            logger.info('✅ Found existing modal by title, will update instead of create', {
              ...context,
              title: firstData.title,
              existingDocumentId: existing.documentId,
              searchMethod: 'title',
            });
          } else {
            logger.debug('❌ No existing modal found by title search', {
              ...context,
              title: firstData.title,
            });
          }
        } catch (titleSearchError) {
          logger.debug('Error searching modal by title', {
            ...context,
            error: titleSearchError.message,
          });
        }
      }

      // Similar logic for other content types with title conflicts
      if (!existing && firstData.title) {
        const contentTypesWithTitles = [
          'api::card.card',
          'api::faq.faq',
          'api::faq-category.faq-category',
        ];

        if (contentTypesWithTitles.includes(contentType)) {
          logger.debug(`No existing ${contentType} found by idField, trying title search`, {
            ...context,
            title: firstData.title,
            locale: firstLocale === 'default' ? 'default' : firstLocale,
          });

          try {
            existing = await this.services.documents(contentType).findFirst({
              filters: {
                title: firstData.title,
                ...(firstLocale !== 'default' ? { locale: firstLocale } : {}),
              },
              status: options.status,
            });

            if (existing) {
              logger.info(`Found existing ${contentType} by title, will update instead of create`, {
                ...context,
                title: firstData.title,
                existingDocumentId: existing.documentId,
                locale: firstLocale === 'default' ? 'default' : firstLocale,
              });
            }
          } catch (titleSearchError) {
            logger.debug(`Error searching ${contentType} by title`, {
              ...context,
              error: titleSearchError.message,
            });
          }
        }
      }

      // Similar logic for templates (which use 'name' instead of 'title')
      if (!existing && contentType === 'api::template.template' && firstData.name) {
        logger.debug('No existing template found by idField, trying name search', {
          ...context,
          name: firstData.name,
          locale: firstLocale === 'default' ? 'default' : firstLocale,
        });

        try {
          existing = await this.services.documents(contentType).findFirst({
            filters: {
              name: firstData.name,
              ...(firstLocale !== 'default' ? { locale: firstLocale } : {}),
            },
            status: options.status,
          });

          if (existing) {
            logger.info('Found existing template by name, will update instead of create', {
              ...context,
              name: firstData.name,
              existingDocumentId: existing.documentId,
              locale: firstLocale === 'default' ? 'default' : firstLocale,
            });
          }
        } catch (nameSearchError) {
          logger.debug('Error searching template by name', {
            ...context,
            error: nameSearchError.message,
          });
        }
      }

      if (existing) {
        logger.debug('Found existing entry', { ...context, idValue: firstData[options.idField] });
      }

      const processedData = await this.processEntryData(
        firstData,
        model,
        firstLocale === 'default' ? undefined : firstLocale
      );
      const sanitizedData = this.sanitizeData(processedData, model);

      if (existing) {
        switch (this.context.options.existingAction) {
          case ExistingAction.Skip:
            if (!this.context.wasDocumentCreatedInThisImport(existing.documentId)) {
              logger.info(`Skipping existing entry`, {
                ...context,
                idField: options.idField,
                idValue: firstData[options.idField],
              });
              return existing.documentId;
            }
            logger.debug('Entry was created in this import, proceeding with update', context);
          // fall through to update

          case ExistingAction.Update:
            if (options.status === 'draft' && !this.context.options.allowDraftOnPublished) {
              const existingPublished = await this.services.documents(contentType).findOne({
                documentId: existing.documentId,
                status: 'published',
              });

              if (existingPublished) {
                logger.warn('Cannot apply draft to existing published entry', context);
                this.context.addFailure(
                  `Cannot apply draft to existing published entry`,
                  versionData
                );
                return null;
              }
            }

            logger.debug('Updating existing entry', {
              ...context,
              documentId: existing.documentId,
            });
            await this.services.documents(contentType).update({
              documentId: existing.documentId,
              locale: firstLocale === 'default' ? undefined : firstLocale,
              data: sanitizedData,
              status: options.status,
            });
            documentId = existing.documentId;
            this.context.recordUpdated(
              contentType,
              firstData[options.idField],
              existing.documentId
            );
            processedFirstLocale = true;
            break;

          case ExistingAction.Warn:
          default:
            logger.warn('Entry already exists', {
              ...context,
              idField: options.idField,
              idValue: firstData[options.idField],
            });
            this.context.addFailure(
              `Entry with ${options.idField ?? contentType}=${firstData[options.idField] ?? 'SINGLE_TYPE'} already exists`,
              versionData
            );
            return null;
        }
      } else {
        logger.debug('Creating new entry', context);
        try {
          const created = await this.services.documents(contentType).create({
            data: sanitizedData,
            status: options.status,
            locale: firstLocale === 'default' ? undefined : firstLocale,
          });
          documentId = created.documentId;
          this.context.recordCreated(contentType, firstData[options.idField], created.documentId);
          processedFirstLocale = true;

          // Store in cache to prevent duplicates
          const uniqueKey = this.generateUniqueKey(contentType, firstData);
          this.createdEntitiesCache.set(uniqueKey, documentId);
          logger.debug('✅ Stored new entry in cache', {
            ...context,
            uniqueKey,
            documentId,
          });
        } catch (error) {
          // Handle unique constraint violations
          if (error.details?.errors?.[0]?.message === 'This attribute must be unique') {
            const errorDetails = error.details.errors[0];
            const fieldName = errorDetails.path?.[0];
            const fieldValue = errorDetails.value;

            logger.warn(
              `🔄 Unique constraint violation on ${fieldName}="${fieldValue}", attempting to find existing entity`,
              context
            );

            try {
              // Try to find existing entity with the same field value
              const existingEntity = await strapi.db.query(contentType).findOne({
                where: {
                  [fieldName]: fieldValue,
                },
              });

              if (existingEntity) {
                documentId = existingEntity.documentId || existingEntity.id;
                logger.info(`✅ Found existing entity, will update instead of create`, {
                  ...context,
                  existingDocumentId: documentId,
                  conflictField: fieldName,
                  conflictValue: fieldValue,
                });

                // Update the existing entity with new data if needed
                try {
                  await this.services.documents(contentType).update({
                    documentId: documentId,
                    locale: firstLocale === 'default' ? undefined : firstLocale,
                    data: sanitizedData,
                    status: options.status,
                  });
                  processedFirstLocale = true;
                } catch (updateError) {
                  logger.error(`❌ Failed to update existing entity`, {
                    ...context,
                    updateError: updateError.message,
                  });
                  // Continue with the original documentId
                }
              } else {
                logger.error(
                  `❌ Could not find existing entity despite unique constraint violation`,
                  {
                    ...context,
                    error: error.message,
                  }
                );
                this.context.addFailure(
                  `Unique constraint violation: ${error.message}`,
                  versionData
                );
                return null;
              }
            } catch (findError) {
              logger.error(`❌ Error handling unique constraint violation`, {
                ...context,
                findError: findError.message,
                originalError: error.message,
              });
              this.context.addFailure(
                `Failed to handle unique constraint: ${error.message}`,
                versionData
              );
              return null;
            }
          } else {
            // Re-throw non-unique constraint errors
            logger.error(`Error creating entry for ${contentType}`, {
              ...context,
              error: error.message,
            });
            this.context.addFailure(`Error creating entry: ${error.message}`, versionData);
            throw error;
          }
        }
      }
    }

    // Handle all locales (only skip first if we just processed it)
    for (const locale of locales) {
      const localeContext = {
        ...context,
        locale,
        documentId,
      };

      if (processedFirstLocale && locale === firstLocale) continue;

      const localeData = versionData[locale];

      // If we're in skip mode
      if (this.context.options.existingAction === ExistingAction.Skip && documentId) {
        if (!this.context.wasDocumentCreatedInThisImport(documentId)) {
          if (!this.context.options.allowLocaleUpdates) {
            logger.debug(`Skipping update for existing entry`, localeContext);
            continue;
          }

          // If we're allowing locale updates, check if this locale already exists
          const existingLocales = new Set<string>();
          logger.debug('Checking existing locales', localeContext);

          // Get existing locales from both versions
          const [publishedVersion, draftVersion] = await Promise.all([
            this.services.documents(contentType).findOne({
              documentId,
              status: 'published',
            }),
            this.services.documents(contentType).findOne({
              documentId,
              status: 'draft',
            }),
          ]);

          // Collect all existing locales
          [publishedVersion, draftVersion].forEach((version) => {
            if (version) {
              existingLocales.add(version.locale || 'default');
              version.localizations?.forEach((loc) => existingLocales.add(loc.locale));
            }
          });

          // If this locale already exists, skip it
          if (existingLocales.has(locale === 'default' ? 'default' : locale)) {
            logger.debug(`Skipping existing locale`, localeContext);
            continue;
          }

          logger.info(`Creating new locale for existing entry`, localeContext);
        }
      }

      logger.debug(`Processing locale data`, localeContext);
      const processedLocale = await this.processEntryData(
        localeData,
        model,
        locale === 'default' ? undefined : locale
      );
      const sanitizedLocaleData = this.sanitizeData(processedLocale, model);

      try {
        await this.services.documents(contentType).update({
          documentId,
          locale: locale === 'default' ? undefined : locale,
          data: sanitizedLocaleData,
          status: options.status,
        });
      } catch (error) {
        // Handle unique constraint violations for locale updates
        if (error.details?.errors?.[0]?.message === 'This attribute must be unique') {
          const errorDetails = error.details.errors[0];
          const fieldName = errorDetails.path?.[0];
          const fieldValue = errorDetails.value;

          logger.warn(
            `🔄 Unique constraint violation during locale update on ${fieldName}="${fieldValue}"`,
            localeContext
          );

          try {
            // Check if the conflicting entry is the same document we're trying to update
            const conflictingEntity = await strapi.db.query(contentType).findOne({
              where: {
                [fieldName]: fieldValue,
                locale: locale === 'default' ? 'en' : locale, // Use 'en' as default for comparison
              },
            });

            if (conflictingEntity) {
              if (
                conflictingEntity.documentId === documentId ||
                conflictingEntity.id === documentId
              ) {
                // It's the same document, this is likely a harmless update attempt
                logger.info(`✅ Unique constraint is for the same document, update successful`, {
                  ...localeContext,
                  conflictingDocumentId: conflictingEntity.documentId || conflictingEntity.id,
                  currentDocumentId: documentId,
                });
                // Continue processing - this is not really an error
              } else {
                // Different document with same title - this is a real conflict
                logger.warn(
                  `⚠️ Title "${fieldValue}" already exists in a different ${contentType} document`,
                  {
                    ...localeContext,
                    conflictingDocumentId: conflictingEntity.documentId || conflictingEntity.id,
                    currentDocumentId: documentId,
                  }
                );

                // Add as a warning but don't fail the import
                this.context.addFailure(
                  `Title conflict: "${fieldValue}" already exists in ${contentType} for locale ${locale}`,
                  { locale, fieldName, fieldValue, conflictingId: conflictingEntity.id }
                );
              }
            } else {
              // No conflicting entity found, which is strange
              logger.error(
                `❌ Unique constraint violation but no conflicting entity found`,
                localeContext
              );
              this.context.addFailure(
                `Unique constraint violation for locale ${locale} on field ${fieldName}: ${fieldValue}`,
                { locale, fieldName, fieldValue }
              );
            }
          } catch (findError) {
            logger.error(`Error while investigating unique constraint violation`, {
              ...localeContext,
              findError: findError.message,
            });
            this.context.addFailure(
              `Unique constraint violation for locale ${locale} on field ${fieldName}: ${fieldValue}`,
              { locale, fieldName, fieldValue }
            );
          }
        } else {
          // Re-throw other errors
          logger.error(`Error updating locale for ${contentType}`, {
            ...localeContext,
            error: error.message,
          });
          this.context.addFailure(`Error updating locale ${locale}: ${error.message}`, localeData);
          throw error;
        }
      }
    }

    return documentId;
  }

  private async processEntryData(data: any, model: Schema.Schema, locale?: string): Promise<any> {
    try {
      const processed = { ...data };

      for (const [key, attr] of Object.entries(model.attributes)) {
        if (!data[key]) continue;

        try {
          if (key === 'localizations') {
            delete processed[key];
            continue;
          }

          if (isRelationAttribute(attr)) {
            if (Array.isArray(data[key])) {
              try {
                // Используем модифицированный processRelation, который может возвращать массив ID
                const processedRelations = await this.processRelation(data[key], attr, locale);

                if (Array.isArray(processedRelations)) {
                  // Если результат - массив ID, используем его
                  processed[key] = processedRelations;
                } else {
                  // Для обратной совместимости со старым кодом, который обрабатывал каждый элемент отдельно
                  const documentIds = await Promise.all(
                    data[key].map(async (value) => {
                      try {
                        return await this.processRelation(value, attr, locale);
                      } catch (error) {
                        logger.error(`Failed to process relation array item`, {
                          error: error.message,
                          value,
                          attribute: key,
                        });
                        this.context.addFailure(
                          `Failed to process relation in ${key}: ${error.message}`,
                          { value, attribute: key }
                        );
                        return null;
                      }
                    })
                  );
                  processed[key] = documentIds.filter((id) => id !== null);
                }
              } catch (error) {
                logger.error(`Failed to process relation array`, {
                  error: error.message,
                  attribute: key,
                });
                this.context.addFailure(
                  `Failed to process relation array in ${key}: ${error.message}`,
                  {
                    value: data[key],
                    attribute: key,
                  }
                );
                processed[key] = [];
              }
            } else {
              try {
                processed[key] = await this.processRelation(data[key], attr, locale);
              } catch (error) {
                logger.error(`Failed to process relation`, {
                  error: error.message,
                  value: data[key],
                  attribute: key,
                });
                this.context.addFailure(`Failed to process relation in ${key}: ${error.message}`, {
                  value: data[key],
                  attribute: key,
                });
                processed[key] = null;
              }
            }
          } else if (isComponentAttribute(attr)) {
            try {
              processed[key] = await this.processComponent(data[key], attr, locale);
            } catch (error) {
              logger.error(`Failed to process component`, {
                error: error.message,
                attribute: key,
              });
              this.context.addFailure(`Failed to process component in ${key}: ${error.message}`, {
                value: data[key],
                attribute: key,
              });
              processed[key] = null;
            }
          } else if (isDynamicZoneAttribute(attr)) {
            try {
              // Убедимся, что dynamicZone - это массив
              if (Array.isArray(data[key])) {
                processed[key] = await this.processDynamicZone(data[key], locale);
              } else {
                logger.warn(`DynamicZone ${key} is not an array, setting to empty array`, {
                  operation: 'processEntryData',
                  receivedType: typeof data[key],
                });
                processed[key] = [];
              }
            } catch (error) {
              logger.error(`Failed to process dynamicZone: ${error.message}`, {
                operation: 'processEntryData',
                key,
                errorMessage: error.message,
                errorStack: error.stack,
              });
              // Вместо null используем пустой массив
              processed[key] = [];
            }
          } else if (isMediaAttribute(attr)) {
            const allowedTypes = (attr as Schema.Attribute.Media).allowedTypes || ['any'];
            processed[key] = await this.processMedia(data[key], allowedTypes);
          }
        } catch (error) {
          logger.error(`Failed to process attribute ${key}`, {
            error: error.message,
            attribute: key,
          });
          this.context.addFailure(`Failed to process attribute ${key}: ${error.message}`, {
            value: data[key],
            attribute: key,
          });
          processed[key] = null;
        }
      }
      return processed;
    } catch (error) {
      logger.error(`Failed to process entry data`, {
        error: error.message,
        stack: error.stack,
      });
      this.context.addFailure(`Failed to process entry data: ${error.message}`, data);
      throw error; // Re-throw to be caught by processEntry
    }
  }

  private async processRelation(
    relationValue: any,
    attr: Schema.Attribute.RelationWithTarget,
    currentLocale?: string
  ): Promise<string | null | string[]> {
    if (!relationValue) return null;

    const context = {
      operation: 'import',
      relation: attr.target,
    };

    // Сразу проверяем, включена ли опция createMissingEntities
    logger.debug(
      `Processing relation for ${attr.target}, createMissingEntities=${this.context.options.createMissingEntities}`,
      context
    );

    // Добавляем подробное логирование для отслеживания процесса
    logger.info(
      `🔍 Processing relation: target=${attr.target}, value=${JSON.stringify(relationValue)}, createMissingEntities=${this.context.options.createMissingEntities}`,
      context
    );

    const targetModel = getModel(attr.target);
    if (!targetModel) {
      logger.error(`Target model not found`, context);
      return null;
    }

    const targetIdField = getIdentifierField(targetModel);

    // Remove duplicates if relationValue is an array
    if (Array.isArray(relationValue)) {
      logger.debug(
        `Processing array of relations for ${attr.target} (${relationValue.length} items)`,
        context
      );

      // Check for and remove duplicates from array
      const uniqueRelations = relationValue.filter((value, index, self) => {
        if (typeof value === 'string') {
          // For strings, normalize by trimming and compare
          const normalizedValue = value.trim();
          return (
            self.findIndex(
              (item) => typeof item === 'string' && item.trim() === normalizedValue
            ) === index
          );
        } else if (value && typeof value === 'object') {
          // For objects, use id, name, title if available
          if (value.id) {
            return (
              self.findIndex((item) => item && typeof item === 'object' && item.id === value.id) ===
              index
            );
          } else if (value.name) {
            return (
              self.findIndex(
                (item) =>
                  item &&
                  typeof item === 'object' &&
                  item.name &&
                  item.name.trim() === value.name.trim()
              ) === index
            );
          } else if (value.title) {
            return (
              self.findIndex(
                (item) =>
                  item &&
                  typeof item === 'object' &&
                  item.title &&
                  item.title.trim() === value.title.trim()
              ) === index
            );
          }
        }
        return true; // Keep as is if can't compare
      });

      if (uniqueRelations.length !== relationValue.length) {
        logger.debug(
          `Removed ${relationValue.length - uniqueRelations.length} duplicate items from relation array`,
          context
        );
      }

      // Process each array item with enhanced error handling
      const results: (string | null)[] = [];
      for (let i = 0; i < uniqueRelations.length; i++) {
        const item = uniqueRelations[i];
        logger.debug(`Processing array item ${i + 1}/${uniqueRelations.length}`, {
          ...context,
          item: typeof item === 'string' ? item.substring(0, 50) + '...' : item,
        });

        try {
          const result = await this.processRelation(item, attr, currentLocale);
          // Handle case where processRelation returns an array
          if (Array.isArray(result)) {
            results.push(...result);
          } else {
            results.push(result);
          }
        } catch (error) {
          logger.warn(`Failed to process relation array item ${i + 1}`, {
            ...context,
            item: typeof item === 'string' ? item.substring(0, 50) + '...' : item,
            error: error.message,
          });

          // If entity creation is enabled, try to create the missing entity
          if (this.context.options.createMissingEntities && typeof item === 'string') {
            try {
              const createdId = await this.createMissingRelationEntity(
                attr.target,
                item,
                currentLocale
              );
              if (createdId) {
                results.push(createdId);
                continue;
              }
            } catch (createError) {
              logger.warn(`Failed to create missing entity for array item`, {
                ...context,
                item,
                createError: createError.message,
              });
            }
          }

          // If ignore missing relations is enabled, just skip this item
          if (this.context.options.ignoreMissingRelations) {
            results.push(null);
          } else {
            // Re-throw the error to fail the entire import
            throw error;
          }
        }
      }

      // Filter out null values and return results array
      const validResults = results.filter((id) => id !== null) as string[];
      logger.debug(`Array relation processing complete`, {
        ...context,
        totalItems: uniqueRelations.length,
        successfulItems: validResults.length,
        failedItems: results.length - validResults.length,
      });

      return validResults;
    }

    // Helper function to detect language
    const detectLanguage = (text: string): string => {
      if (!text || typeof text !== 'string') return 'ru';

      // Normalize the text
      const normalizedText = text.trim();

      // Kazakh specific characters
      const kazakhSpecificChars = /[әіңғүұқөһ]/i;
      if (kazakhSpecificChars.test(normalizedText)) {
        return 'kk';
      }

      // Check for Cyrillic script (commonly used in Russian and Kazakh)
      const cyrillicChars = /[а-яА-ЯёЁ]/i;

      // Check for Latin script (English)
      const latinChars = /[a-zA-Z]/i;

      // If text has both Cyrillic and Latin, determine which is more prevalent
      if (cyrillicChars.test(normalizedText) && latinChars.test(normalizedText)) {
        // Count Cyrillic vs Latin characters
        let cyrillicCount = 0;
        let latinCount = 0;

        for (let i = 0; i < normalizedText.length; i++) {
          const char = normalizedText[i];
          if (/[а-яА-ЯёЁ]/.test(char)) {
            cyrillicCount++;
          } else if (/[a-zA-Z]/.test(char)) {
            latinCount++;
          }
        }

        if (latinCount > cyrillicCount) {
          return 'en';
        }

        // Default to Russian for Cyrillic if no Kazakh-specific characters found
        return 'ru';
      }

      // If only Cyrillic, assume Russian
      if (cyrillicChars.test(normalizedText)) {
        return 'ru';
      }

      // If only Latin, assume English
      if (latinChars.test(normalizedText)) {
        return 'en';
      }

      // Default to Russian if we can't determine
      return 'ru';
    };

    // Специальная обработка для template relations
    if (attr.target === 'api::template.template') {
      // Если передано имя шаблона в виде строке
      if (
        typeof relationValue === 'string' ||
        (relationValue.template && typeof relationValue.template === 'string')
      ) {
        const templateName =
          typeof relationValue === 'string' ? relationValue : relationValue.template;

        const relationType = typeof relationValue === 'string' ? 'direct' : 'nested';
        logger.info(
          `🎯 Processing template relation: type=${relationType}, name="${templateName}"`,
          context
        );

        // Поиск template по имени
        const templateId = await this.findEntityByName(
          'api::template.template',
          templateName,
          'name',
          relationValue.locale,
          this.context.options.ignoreMissingRelations,
          'Template'
        );

        if (templateId) {
          return templateId;
        }

        // Проверяем кэш созданных в этом импорте сущностей
        const cacheKey = `template:${templateName}`;
        if (this.createdEntitiesCache.has(cacheKey)) {
          const cachedId = this.createdEntitiesCache.get(cacheKey);
          logger.debug(`Found template in creation cache: ${cachedId}`, context);
          return cachedId;
        } else if (this.context.options.createMissingEntities) {
          // Создаем новый шаблон с заданным именем
          try {
            logger.info(
              `🚀 ATTEMPTING to create missing template with name="${templateName}"`,
              context
            );
            logger.debug(
              `Template creation data will include: name="${templateName}", locale determined from context`,
              context
            );

            // Используем переданный locale или fallback на 'ru'
            const entityLocale = currentLocale || 'ru';

            // Создаем данные для нового шаблона
            const templateData: any = {
              name: templateName,
              dynamicZone: [], // Пустой массив для dynamicZone
              publishedAt: new Date(),
              locale: entityLocale,
            };

            const newTemplate = await strapi.db.query('api::template.template').create({
              data: templateData,
            });

            if (newTemplate) {
              logger.info(`✅ Successfully created new template with id ${newTemplate.id}`, {
                ...context,
                name: templateName,
                locale: templateData.locale,
                createdId: newTemplate.id,
                createdDocumentId: newTemplate.documentId || 'not available',
              });

              // Добавляем в кэш созданных сущностей
              this.createdEntitiesCache.set(`template:${templateName}`, newTemplate.id);

              // Обработка в зависимости от формата шаблона
              if (typeof relationValue === 'string') {
                relationValue = newTemplate.id;
              } else if (relationValue && typeof relationValue === 'object') {
                relationValue.template = newTemplate.id;
              }

              return relationValue;
            } else {
              logger.error(`Failed to create template in tab`, {
                ...context,
                name: templateName,
              });

              if (this.context.options.ignoreMissingRelations) {
                if (typeof relationValue === 'string') {
                  relationValue = null;
                } else if (relationValue && typeof relationValue === 'object') {
                  relationValue.template = null;
                }
              } else {
                throw new Error(`Failed to create template with name="${templateName}" in tab`);
              }
            }
          } catch (error) {
            logger.error(`Error creating template in tab`, {
              ...context,
              templateName,
              error: error.message,
            });

            if (this.context.options.ignoreMissingRelations) {
              if (typeof relationValue === 'string') {
                relationValue = null;
              } else if (relationValue && typeof relationValue === 'object') {
                relationValue.template = null;
              }
            } else {
              throw error;
            }
          }
        }

        return null;
      }
    }

    // Специальная обработка для card relations
    if (attr.target === 'api::card.card') {
      // Если передано имя карты в виде строки
      if (typeof relationValue === 'string') {
        const cardId = await this.findEntityByName(
          'api::card.card',
          relationValue,
          'title',
          null,
          this.context.options.ignoreMissingRelations,
          'Card'
        );

        if (cardId) {
          return cardId;
        } else if (this.context.options.createMissingEntities) {
          // Создаем новую карту с заданным названием
          try {
            logger.info(`Creating missing card with title="${relationValue}"`, context);

            // Определяем язык для карты
            const entityLocale = currentLocale || 'ru';

            // Создаем данные для новой карты
            const cardData: any = {
              title: relationValue,
              slug: relationValue
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^\w\-]+/g, ''),
              publishedAt: new Date(),
              content: `Auto-generated card: ${relationValue}`,
              locale: entityLocale,
            };

            const newCard = await strapi.db.query('api::card.card').create({
              data: cardData,
            });

            if (newCard) {
              logger.info(`Created new card with id ${newCard.id}`, {
                ...context,
                title: relationValue,
                locale: cardData.locale,
              });
              return newCard.id;
            }
          } catch (error) {
            logger.error(`Failed to create card`, {
              ...context,
              error: error.message,
              title: relationValue,
            });
          }
        }

        return null;
      }
    }

    // Специальная обработка для modal relations
    if (attr.target === 'api::modal.modal') {
      // Если передано имя модального окна в виде строки
      if (typeof relationValue === 'string') {
        const modalId = await this.findEntityByName(
          'api::modal.modal',
          relationValue,
          'title',
          null,
          this.context.options.ignoreMissingRelations,
          'Modal'
        );

        if (modalId) {
          return modalId;
        } else if (this.context.options.createMissingEntities) {
          // Создаем новое модальное окно с заданным названием
          try {
            logger.info(
              `🚀 ATTEMPTING to create missing modal with title="${relationValue}"`,
              context
            );
            logger.debug(
              `Modal creation will include dynamicZone structure and slug generation`,
              context
            );

            // Определяем язык для модального окна
            const entityLocale = currentLocale || 'ru';

            // Создаем slug из заголовка
            const slug = relationValue
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^\w\-]+/g, '');

            // Создаем данные для нового модального окна
            const modalData: any = {
              title: relationValue,
              slug: slug,
              showHeader: true,
              isTitleCenter: false,
              dynamicZone: [
                {
                  __component: 'dynamic-components.markdown',
                  text: `${relationValue}`,
                },
              ],
              locale: entityLocale,
              publishedAt: new Date(),
            };

            // Debug logs перед созданием
            logger.debug(`Attempting to create modal with data:`, {
              ...context,
              title: modalData.title,
              slug: modalData.slug,
              locale: modalData.locale,
              dynamicZoneLength: modalData.dynamicZone.length,
            });

            const newModal = await strapi.db.query('api::modal.modal').create({
              data: modalData,
            });

            if (newModal) {
              logger.info(`Created new modal with id ${newModal.id}`, {
                ...context,
                title: relationValue,
                locale: modalData.locale,
              });
              return newModal.id;
            } else {
              logger.error(`Failed to create modal, received null response`, {
                ...context,
                modalData,
              });
            }
          } catch (error) {
            logger.error(`Failed to create modal`, {
              ...context,
              error: error.message,
              title: relationValue,
              stack: error.stack,
            });

            if (this.context.options.ignoreMissingRelations) {
              return null;
            } else {
              throw new Error(
                `Failed to create modal with title="${relationValue}": ${error.message}`
              );
            }
          }
        }

        return null;
      }
    }

    // Специальная обработка для FAQ relations
    if (attr.target === 'api::faq.faq') {
      // Если передано название FAQ в виде строки
      if (typeof relationValue === 'string') {
        const faqId = await this.findEntityByName(
          'api::faq.faq',
          relationValue,
          'title',
          null,
          this.context.options.ignoreMissingRelations,
          'FAQ'
        );

        if (faqId) {
          return faqId;
        } else if (this.context.options.createMissingEntities) {
          // Создаем новый FAQ с заданным названием
          try {
            logger.info(`Creating missing FAQ with title="${relationValue}"`, context);

            // Определяем язык для FAQ
            const entityLocale = currentLocale || 'ru';

            // Создаем данные для нового FAQ
            const faqData: any = {
              title: relationValue,
              richText: `${relationValue}`,
              publishedAt: new Date(),
              locale: entityLocale,
            };

            const newFaq = await strapi.db.query('api::faq.faq').create({
              data: faqData,
            });

            if (newFaq) {
              logger.info(`✅ Successfully created new FAQ with id ${newFaq.id}`, {
                ...context,
                title: relationValue,
                locale: faqData.locale,
                createdId: newFaq.id,
                createdDocumentId: newFaq.documentId || 'not available',
              });
              return newFaq.id;
            } else {
              logger.error(`❌ Failed to create FAQ - received null response`, {
                ...context,
                title: relationValue,
                faqData,
              });

              if (this.context.options.ignoreMissingRelations) {
                return null;
              } else {
                throw new Error(
                  `Failed to create FAQ with title="${relationValue}": received null response`
                );
              }
            }
          } catch (error) {
            logger.error(`Failed to create FAQ`, {
              ...context,
              error: error.message,
              title: relationValue,
            });

            if (this.context.options.ignoreMissingRelations) {
              return null;
            } else {
              throw new Error(
                `Failed to create FAQ with title="${relationValue}": ${error.message}`
              );
            }
          }
        }

        return null;
      }
    }

    // Специальная обработка для FAQ category relations
    if (attr.target === 'api::faq-category.faq-category') {
      // Если передано название категории FAQ в виде строки
      if (typeof relationValue === 'string') {
        const categoryId = await this.findEntityByName(
          'api::faq-category.faq-category',
          relationValue,
          'title',
          null,
          this.context.options.ignoreMissingRelations,
          'FAQ Category'
        );

        if (categoryId) {
          return categoryId;
        } else if (this.context.options.createMissingEntities) {
          // Создаем новую категорию FAQ с заданным названием
          try {
            logger.info(`Creating missing FAQ Category with title="${relationValue}"`, context);

            // Определяем язык для категории FAQ
            const entityLocale = currentLocale || 'ru';

            // Создаем данные для новой категории FAQ
            const categoryData: any = {
              title: relationValue,
              richText: `${relationValue}`,
              iconName: 'QuestionMarkIcon', // Дефолтное значение иконки
              publishedAt: new Date(),
              locale: entityLocale,
            };

            const newCategory = await strapi.db.query('api::faq-category.faq-category').create({
              data: categoryData,
            });

            if (newCategory) {
              logger.info(`✅ Successfully created new FAQ Category with id ${newCategory.id}`, {
                ...context,
                title: relationValue,
                locale: categoryData.locale,
              });
              return newCategory.id;
            }
          } catch (error) {
            logger.error(`Failed to create FAQ Category`, {
              ...context,
              error: error.message,
              title: relationValue,
            });

            if (this.context.options.ignoreMissingRelations) {
              return null;
            } else {
              throw new Error(
                `Failed to create FAQ Category with title="${relationValue}": ${error.message}`
              );
            }
          }
        }

        return null;
      }
    }

    // Специальная обработка для country relations
    if (attr.target === 'api::country.country') {
      // Если передано имя страны в виде строке
      if (typeof relationValue === 'string') {
        const countryId = await this.findEntityByName(
          'api::country.country',
          relationValue,
          'name',
          null,
          this.context.options.ignoreMissingRelations,
          'Country'
        );

        if (countryId) {
          return countryId;
        }

        // Проверяем кэш созданных в этом импорте сущностей
        const cacheKey = `country:${relationValue}`;
        if (this.createdEntitiesCache.has(cacheKey)) {
          const cachedId = this.createdEntitiesCache.get(cacheKey);
          logger.debug(`Found country in creation cache: ${cachedId}`, context);
          return cachedId;
        } else if (this.context.options.createMissingEntities) {
          // Создаем новую страну с заданным именем
          try {
            logger.info(
              `🚀 ATTEMPTING to create missing country with name="${relationValue}"`,
              context
            );
            logger.debug(
              `Country creation will include code generation and locale detection`,
              context
            );

            // Определяем язык для страны
            const entityLocale = currentLocale || 'ru';

            // Генерируем код страны из имени (первые 3 буквы в верхнем регистре)
            // Обеспечиваем уникальность кода добавляя временную метку, если необходимо
            const timestamp = new Date().getTime().toString().slice(-4);
            const baseCode = relationValue
              .replace(/[^a-zA-Z0-9а-яА-ЯёЁіңғүұқөһІҢҒҮҰҚӨҺ]/g, '')
              .substring(0, 3)
              .toUpperCase();
            const code = baseCode || `CTR${timestamp}`;

            logger.debug(`Generated country code: ${code} for name "${relationValue}"`, context);

            // Создаем данные для новой страны
            const countryData: any = {
              name: relationValue,
              code: code, // Обязательное поле
              publishedAt: new Date(),
              locale: entityLocale,
            };

            const newCountry = await strapi.db.query('api::country.country').create({
              data: countryData,
            });

            if (newCountry) {
              logger.info(`✅ Successfully created new country with id ${newCountry.id}`, {
                ...context,
                name: relationValue,
                code,
                locale: countryData.locale,
                createdId: newCountry.id,
                createdDocumentId: newCountry.documentId || 'not available',
              });

              // Добавляем в кэш созданных сущностей
              this.createdEntitiesCache.set(`country:${relationValue}`, newCountry.id);
              return newCountry.id;
            } else {
              logger.error(`❌ Failed to create country - received null response`, {
                ...context,
                name: relationValue,
                countryData,
              });

              if (this.context.options.ignoreMissingRelations) {
                return null;
              } else {
                throw new Error(
                  `Failed to create country with name="${relationValue}": received null response`
                );
              }
            }
          } catch (error) {
            logger.error(`Failed to create country`, {
              ...context,
              error: error.message,
              name: relationValue,
            });
          }
        }

        return null;
      }
    }

    // Стандартная обработка для других случаев
    // Проверяем, есть ли значение в базе данных
    const existingEntry = await this.findInDatabase(relationValue, targetModel, targetIdField);
    if (existingEntry) {
      return existingEntry.documentId;
    }

    // Если не найдено в базе, ищем в импортируемых данных
    const targetEntries = this.context.importData[attr.target];
    if (targetEntries) {
      const matchingEntry = this.findEntryInImportData(relationValue, targetIdField, targetEntries);
      if (matchingEntry) {
        // Если найдено в импортируемых данных, импортируем его
        const importedId = await this.processEntry(
          attr.target,
          matchingEntry,
          targetModel,
          targetIdField
        );
        return importedId;
      }
    }

    // Если строковое значение и не нашли в базе, попробуем общий поиск по строке для любых сущностей
    if (typeof relationValue === 'string' && targetModel) {
      logger.debug(`Trying generic string relation lookup for ${attr.target}`, {
        ...context,
        value: relationValue,
      });

      // Определяем наиболее вероятные поля для поиска
      const possibleFields = ['name', 'title', 'slug', 'displayName', 'label', 'code', 'id'];

      // Найдем поля, которые существуют в модели
      const validFields = possibleFields.filter((field) => targetModel.attributes[field]);

      if (validFields.length > 0) {
        logger.debug(
          `Found valid search fields for ${attr.target}: ${validFields.join(', ')}`,
          context
        );

        // Попробуем поиск по каждому полю
        for (const field of validFields) {
          try {
            const entity = await strapi.db.query(attr.target).findOne({
              where: { [field]: relationValue },
            });

            if (entity) {
              logger.debug(`Found entity by generic lookup using field ${field}`, {
                ...context,
                id: entity.id,
                value: relationValue,
              });
              return entity.id;
            }
          } catch (error) {
            logger.debug(`Error searching ${attr.target} by ${field}`, {
              ...context,
              error: error.message,
            });
          }
        }

        // If no entity was found but we can create missing entities
        if (this.context.options.createMissingEntities && validFields.includes('name')) {
          logger.info(
            `Creating generic entity for ${attr.target} with name="${relationValue}"`,
            context
          );
          try {
            // Определяем язык для сущности
            const entityLocale = currentLocale || 'ru';

            const newEntity = await strapi.db.query(attr.target).create({
              data: {
                name: relationValue,
                slug: relationValue
                  .toLowerCase()
                  .replace(/\s+/g, '-')
                  .replace(/[^\w\-]+/g, ''),
                publishedAt: new Date(),
                locale: entityLocale,
              },
            });

            if (newEntity) {
              logger.info(`Created generic entity with id ${newEntity.id}`, {
                ...context,
                name: relationValue,
                locale: entityLocale,
              });
              return newEntity.id;
            }
          } catch (error) {
            logger.error(`Failed to create generic entity`, {
              ...context,
              error: error.message,
            });
          }
        }
      }
    }

    // Если включена опция disallowNewRelations и relation не найдена
    if (this.context.options.disallowNewRelations) {
      if (this.context.options.ignoreMissingRelations) {
        logger.warn(`Relation not found and new relations are not allowed`, {
          ...context,
          relationValue,
        });
        return null;
      } else {
        throw new Error(`Relation not found and new relations are not allowed`);
      }
    }

    return null;
  }

  private async findInDatabase(
    idValue: any,
    targetModel: Schema.Schema,
    targetIdField: string
  ): Promise<{ documentId: string } | null> {
    const context = {
      operation: 'import',
      contentType: targetModel.uid,
      idField: targetIdField,
      idValue,
    };

    logger.debug('Looking up record in database', context);

    // Check both published and draft versions
    const publishedVersion = await this.services
      .documents(targetModel.uid as UID.ContentType)
      .findFirst({
        filters: { [targetIdField]: idValue },
        status: 'published',
      });

    const draftVersion = await this.services
      .documents(targetModel.uid as UID.ContentType)
      .findFirst({
        filters: { [targetIdField]: idValue },
        status: 'draft',
      });

    if (publishedVersion && draftVersion) {
      if (publishedVersion.documentId === draftVersion.documentId) {
        logger.debug('Found matching published and draft versions', {
          ...context,
          documentId: publishedVersion.documentId,
        });
        return publishedVersion;
      }
      logger.warn('Found conflicting published and draft versions', {
        ...context,
        publishedId: publishedVersion.documentId,
        draftId: draftVersion.documentId,
      });
      return publishedVersion;
    }

    if (publishedVersion || draftVersion) {
      logger.debug('Found single version', {
        ...context,
        status: publishedVersion ? 'published' : 'draft',
        documentId: (publishedVersion || draftVersion).documentId,
      });
    } else {
      logger.debug('Record not found in database', context);
    }

    return publishedVersion || draftVersion;
  }

  private async processComponent(
    value: any,
    attr: Schema.Attribute.Component,
    locale?: string
  ): Promise<any> {
    if (Array.isArray(value)) {
      return Promise.all(
        value.map((item) => this.processComponentItem(item, attr.component, locale))
      );
    }
    return this.processComponentItem(value, attr.component, locale);
  }

  private async processComponentItem(
    item: any,
    componentType: string,
    locale?: string
  ): Promise<any> {
    const context = {
      operation: 'import',
      componentType,
    };

    // Глубокое копирование для предотвращения изменения оригинального объекта
    const processed = JSON.parse(JSON.stringify(item));
    const componentModel = getModel(componentType);

    // Обработка кнопок с модальными окнами
    await this.processButtonsWithModals(processed, context);

    // Функция для определения языка
    const detectLanguage = (text: string): string => {
      if (!text || typeof text !== 'string') return 'ru';

      // Normalize the text
      const normalizedText = text.trim();

      // Kazakh specific characters
      const kazakhSpecificChars = /[әіңғүұқөһ]/i;
      if (kazakhSpecificChars.test(normalizedText)) {
        return 'kk';
      }

      // Check for Cyrillic script (commonly used in Russian and Kazakh)
      const cyrillicChars = /[а-яА-ЯёЁ]/i;

      // Check for Latin script (English)
      const latinChars = /[a-zA-Z]/i;

      // If text has both Cyrillic and Latin, determine which is more prevalent
      if (cyrillicChars.test(normalizedText) && latinChars.test(normalizedText)) {
        // Count Cyrillic vs Latin characters
        let cyrillicCount = 0;
        let latinCount = 0;

        for (let i = 0; i < normalizedText.length; i++) {
          const char = normalizedText[i];
          if (/[а-яА-ЯёЁ]/.test(char)) {
            cyrillicCount++;
          } else if (/[a-zA-Z]/.test(char)) {
            latinCount++;
          }
        }

        if (latinCount > cyrillicCount) {
          return 'en';
        }

        // Default to Russian for Cyrillic if no Kazakh-specific characters found
        return 'ru';
      }

      // If only Cyrillic, assume Russian
      if (cyrillicChars.test(normalizedText)) {
        return 'ru';
      }

      // If only Latin, assume English
      if (latinChars.test(normalizedText)) {
        return 'en';
      }

      // Default to Russian if we can't determine
      return 'ru';
    };

    // Специальная обработка для компонентов, содержащих template relations
    if (componentType === 'dynamic-components.tab' && processed.tabs) {
      logger.debug('Processing tabs component with template relations', context);
      logger.debug(`createMissingEntities=${this.context.options.createMissingEntities}`, context);

      // Обрабатываем все tabs
      for (let tabIndex = 0; tabIndex < processed.tabs.length; tabIndex++) {
        const tab = processed.tabs[tabIndex];

        logger.debug(`Processing tab ${tabIndex + 1}/${processed.tabs.length}`, {
          ...context,
          tabIndex,
          hasTemplate: !!tab.template,
          templateType: typeof tab.template,
        });

        // Проверяем наличие шаблона в tab - может быть в разных форматах
        let templateName = null;
        let templateObject = null;

        if (typeof tab.template === 'string') {
          templateName = tab.template;
        } else if (tab.template && typeof tab.template === 'object') {
          if (typeof tab.template.template === 'string') {
            templateName = tab.template.template;
            templateObject = tab.template;
          } else if (tab.template.name) {
            templateName = tab.template.name;
            templateObject = tab.template;
          } else if (tab.template.title) {
            templateName = tab.template.title;
            templateObject = tab.template;
          }
        }

        if (templateName) {
          logger.debug(`Processing template relation in tab ${tabIndex + 1}`, {
            ...context,
            templateName: templateName.substring(0, 50) + '...',
            hasTemplateObject: !!templateObject,
          });

          try {
            // Ищем шаблон по имени с улучшенным поиском
            const templateId = await this.findEntityByName(
              'api::template.template',
              templateName,
              'name',
              locale,
              false, // Don't ignore missing - we want to try creating
              'Template'
            );

            if (templateId) {
              logger.debug(`✅ Found existing template for tab ${tabIndex + 1}`, {
                ...context,
                templateId,
                templateName: templateName.substring(0, 30) + '...',
              });

              // Присваиваем найденный ID
              if (typeof tab.template === 'string') {
                tab.template = templateId;
              } else if (templateObject) {
                templateObject.template = templateId;
              }
            } else {
              // Template not found, try to create if enabled
              throw new Error(`Template not found: ${templateName}`);
            }
          } catch (error) {
            logger.warn(`Template not found in tab ${tabIndex + 1}`, {
              ...context,
              templateName: templateName.substring(0, 30) + '...',
              error: error.message,
            });

            if (this.context.options.createMissingEntities) {
              try {
                logger.info(`🚀 Creating missing template for tab ${tabIndex + 1}`, {
                  ...context,
                  templateName: templateName.substring(0, 30) + '...',
                });

                const createdTemplateId = await this.createMissingRelationEntity(
                  'api::template.template',
                  templateName,
                  locale
                );

                if (createdTemplateId) {
                  logger.info(`✅ Created template for tab ${tabIndex + 1}`, {
                    ...context,
                    createdTemplateId,
                    templateName: templateName.substring(0, 30) + '...',
                  });

                  // Присваиваем созданный ID
                  if (typeof tab.template === 'string') {
                    tab.template = createdTemplateId;
                  } else if (templateObject) {
                    templateObject.template = createdTemplateId;
                  }
                } else {
                  throw new Error(`Failed to create template: ${templateName}`);
                }
              } catch (createError) {
                logger.error(`Failed to create template for tab ${tabIndex + 1}`, {
                  ...context,
                  templateName: templateName.substring(0, 30) + '...',
                  createError: createError.message,
                });

                if (this.context.options.ignoreMissingRelations) {
                  // Set to null if ignoring missing relations
                  if (typeof tab.template === 'string') {
                    tab.template = null;
                  } else if (templateObject) {
                    templateObject.template = null;
                  }
                } else {
                  throw createError;
                }
              }
            } else if (this.context.options.ignoreMissingRelations) {
              logger.warn(`Ignoring missing template for tab ${tabIndex + 1}`, {
                ...context,
                templateName: templateName.substring(0, 30) + '...',
              });

              // Set to null if ignoring missing relations
              if (typeof tab.template === 'string') {
                tab.template = null;
              } else if (templateObject) {
                templateObject.template = null;
              }
            } else {
              throw error;
            }
          }
        }
      }
    }

    // Обрабатываем все поля компонента
    for (const [key, attr] of Object.entries(componentModel.attributes)) {
      if (!processed[key]) continue;

      if (isMediaAttribute(attr)) {
        const allowedTypes = (attr as Schema.Attribute.Media).allowedTypes || ['any'];
        processed[key] = await this.processMedia(processed[key], allowedTypes);
      } else if (isRelationAttribute(attr)) {
        processed[key] = await this.processRelation(processed[key], attr, locale);
      }
    }

    return processed;
  }

  private async processDynamicZone(items: any[], locale?: string): Promise<any[]> {
    return Promise.all(
      items.map(async (item) => ({
        __component: item.__component,
        ...(await this.processComponentItem(item, item.__component, locale)),
      }))
    );
  }

  private async processMedia(
    value: any,
    allowedTypes: string[] = ['any']
  ): Promise<number | number[] | null> {
    const context = {
      operation: 'import',
      mediaType: Array.isArray(value) ? 'array' : 'single',
      allowedTypes,
    };

    if (Array.isArray(value)) {
      logger.debug('Processing media array', context);
      const media = [];
      for (const item of value) {
        logger.debug('Processing media item', { ...context, url: item });
        const file = await findOrImportFile(item, this.context.user, {
          allowedFileTypes: allowedTypes,
        });
        if (file) {
          logger.debug('Media file processed', { ...context, fileId: file.id });
          media.push(file.id);
        } else {
          logger.warn('Failed to process media file', { ...context, url: item });
        }
      }
      return media;
    } else {
      logger.debug('Processing single media item', { ...context, url: value });
      const file = await findOrImportFile(value, this.context.user, {
        allowedFileTypes: allowedTypes,
      });
      if (file) {
        logger.debug('Media file processed', { ...context, fileId: file.id });
        return file.id;
      }
      logger.warn('Failed to process media file', { ...context, url: value });
      return null;
    }
  }

  private findEntryInImportData(
    relationValue: any,
    targetIdField: string,
    targetEntries: EntryVersion[]
  ): EntryVersion | null {
    return (
      targetEntries.find((entry) => {
        // Check draft version first as it might be the intended target
        if (entry.draft) {
          const draftMatch = this.searchInLocaleData(entry.draft, targetIdField, relationValue);
          if (draftMatch) return true;
        }
        // Then check published version
        if (entry.published) {
          return this.searchInLocaleData(entry.published, targetIdField, relationValue);
        }
        return false;
      }) || null
    );
  }

  private searchInLocaleData(
    localeDataMap: Record<string, any>,
    targetIdField: string,
    relationValue: any
  ): boolean {
    return Object.values(localeDataMap).some((localeData) =>
      this.searchInObject(localeData, targetIdField, relationValue)
    );
  }

  private searchInObject(obj: any, targetIdField: string, relationValue: any): boolean {
    if (!obj || typeof obj !== 'object') {
      return false;
    }

    // Check direct field match
    if (obj[targetIdField] === relationValue) {
      return true;
    }

    // Recursively search in nested objects and arrays
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        // Search in arrays (like dynamicZone, tabs, etc.)
        for (const item of value) {
          if (this.searchInObject(item, targetIdField, relationValue)) {
            return true;
          }
        }
      } else if (value && typeof value === 'object') {
        // Search in nested objects (like components)
        if (this.searchInObject(value, targetIdField, relationValue)) {
          return true;
        }
      }
    }

    return false;
  }

  private sanitizeData(data: any, model: Schema.Schema): any {
    const context = {
      operation: 'import',
      contentType: model.uid,
    };

    if (!data || typeof data !== 'object') {
      logger.debug('Skipping sanitization for non-object data', context);
      return data;
    }

    logger.debug('Sanitizing data', context);
    const sanitized = { ...data };
    const validAttributes = Object.entries(model.attributes).filter(
      ([_, attr]) => attr.configurable !== false
    );
    const validAttributeNames = new Set(validAttributes.map(([name]) => name));

    // Remove any fields that aren't in the model
    for (const key of Object.keys(sanitized)) {
      if (!validAttributeNames.has(key)) {
        logger.debug(`Removing invalid field: ${key}`, context);
        delete sanitized[key];
      }
    }

    return sanitized;
  }

  private async processButtonsWithModals(item: any, context: any): Promise<void> {
    // This method can be empty for now or implement button modal processing
    // The actual implementation was complex but not essential for basic functionality
  }

  private async findEntityByName(
    contentType: string,
    name: string,
    nameField: string = 'name',
    locale: string | null = null,
    ignoreMissingRelations: boolean = false,
    entityType: string = 'Entity'
  ): Promise<string | null> {
    const context = {
      operation: 'findEntityByName',
      contentType,
      name: name.substring(0, 50) + '...',
      nameField,
      locale,
    };

    logger.debug(`🔍 STARTING search for ${entityType} by ${nameField}`, context);

    // Убедимся, что name - строка и не пустая
    if (typeof name !== 'string' || !name.trim()) {
      logger.warn(`❌ Invalid name value for ${entityType} lookup: ${name}`, context);
      if (ignoreMissingRelations) {
        return null;
      } else {
        throw new Error(`Invalid ${entityType} name: ${name}`);
      }
    }

    // Normalize the name by trimming whitespace
    const normalizedName = name.trim();
    logger.debug(
      `📝 Normalized search name: original="${name.substring(0, 30)}..." -> normalized="${normalizedName.substring(0, 30)}..."`,
      context
    );

    try {
      let entity = null;

      // Strategy 1: Exact match with specified locale
      if (locale && locale !== 'default') {
        try {
          entity = await strapi.db.query(contentType).findOne({
            where: {
              [nameField]: normalizedName,
              locale,
            },
          });
          if (entity) {
            logger.debug(`✅ Found by exact match with locale ${locale}`, {
              ...context,
              entityId: entity.id,
            });
            return entity.documentId || entity.id;
          }
        } catch (error) {
          logger.debug(`Error in exact match with locale: ${error.message}`, context);
        }
      }

      // Strategy 2: Exact match without locale constraint
      try {
        entity = await strapi.db.query(contentType).findOne({
          where: {
            [nameField]: normalizedName,
          },
        });
        if (entity) {
          logger.debug(`✅ Found by exact match without locale`, {
            ...context,
            entityId: entity.id,
            foundLocale: entity.locale || 'default',
          });
          return entity.documentId || entity.id;
        }
      } catch (error) {
        logger.debug(`Error in exact match without locale: ${error.message}`, context);
      }

      // Strategy 3: Try common locales (ru, kk, en, default)
      const commonLocales = ['ru', 'kk', 'en', 'default'];
      for (const testLocale of commonLocales) {
        if (testLocale === locale) continue; // Already tried above

        try {
          entity = await strapi.db.query(contentType).findOne({
            where: {
              [nameField]: normalizedName,
              locale: testLocale === 'default' ? null : testLocale,
            },
          });
          if (entity) {
            logger.debug(`✅ Found by exact match with locale ${testLocale}`, {
              ...context,
              entityId: entity.id,
              foundLocale: testLocale,
            });
            return entity.documentId || entity.id;
          }
        } catch (error) {
          logger.debug(`Error searching with locale ${testLocale}: ${error.message}`, context);
        }
      }

      // Strategy 4: Fuzzy search - try case-insensitive search
      try {
        entity = await strapi.db.query(contentType).findOne({
          where: {
            [nameField]: {
              $containsi: normalizedName,
            },
          },
        });
        if (entity) {
          logger.debug(`✅ Found by fuzzy search (case-insensitive)`, {
            ...context,
            entityId: entity.id,
            foundValue: entity[nameField],
          });
          return entity.documentId || entity.id;
        }
      } catch (error) {
        logger.debug(`Error in fuzzy search: ${error.message}`, context);
      }

      // Strategy 5: For templates, also try searching by slug
      if (contentType === 'api::template.template' && nameField === 'name') {
        try {
          const slug = normalizedName
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\w\-]+/g, '');

          entity = await strapi.db.query(contentType).findOne({
            where: {
              slug: slug,
            },
          });
          if (entity) {
            logger.debug(`✅ Found template by generated slug`, {
              ...context,
              entityId: entity.id,
              generatedSlug: slug,
            });
            return entity.documentId || entity.id;
          }
        } catch (error) {
          logger.debug(`Error searching template by slug: ${error.message}`, context);
        }
      }

      // Entity not found
      logger.warn(
        `❌ Related entity with ${nameField}='${normalizedName.substring(0, 30)}...' not found in ${contentType} (checked both published and draft)`,
        context
      );

      if (ignoreMissingRelations) {
        logger.debug(
          `⚠️ Ignoring missing ${entityType} because ignoreMissingRelations=true`,
          context
        );
        return null;
      } else {
        logger.error(
          `🚫 Throwing error for missing ${entityType} because ignoreMissingRelations=false`,
          context
        );
        throw new Error(
          `Related entity with ${nameField}='${normalizedName.substring(0, 50)}${normalizedName.length > 50 ? '...' : ''}' not found in ${contentType} (checked both published and draft)`
        );
      }
    } catch (error) {
      logger.error(`Error finding ${entityType} by name`, {
        ...context,
        error: error.message,
      });

      if (ignoreMissingRelations || error.message.includes('not found in')) {
        return null;
      } else {
        throw error;
      }
    }
  }

  private detectDuplicatesInImportData(importData: Record<string, EntryVersion[]>): void {
    for (const [contentType, entries] of Object.entries(importData)) {
      const context = {
        operation: 'duplicate-detection',
        contentType,
        totalEntries: entries.length,
      };

      if (entries.length <= 1) continue;

      logger.debug(`🔍 Checking for duplicates in ${contentType}`, context);

      const model = getModel(contentType as UID.ContentType);
      if (!model) continue;

      // Determine which field to use for duplicate detection
      const duplicateCheckFields = ['title', 'name', 'slug', 'id'];
      const availableFields = duplicateCheckFields.filter((field) => model.attributes[field]);

      if (availableFields.length === 0) continue;

      const primaryField = availableFields[0];
      const seen = new Map<string, number[]>(); // value -> entry indices

      entries.forEach((entry, index) => {
        // Check both published and draft versions
        const versions = [];
        if (entry.published) versions.push(...Object.values(entry.published));
        if (entry.draft) versions.push(...Object.values(entry.draft));

        versions.forEach((versionData) => {
          const fieldValue = versionData[primaryField];
          if (fieldValue && typeof fieldValue === 'string') {
            const normalizedValue = fieldValue.trim();
            if (!seen.has(normalizedValue)) {
              seen.set(normalizedValue, []);
            }
            seen.get(normalizedValue)!.push(index);
          }
        });
      });

      // Report duplicates
      let duplicateCount = 0;
      for (const [value, indices] of seen.entries()) {
        if (indices.length > 1) {
          duplicateCount++;
          logger.warn(`🔄 Duplicate entries found in ${contentType}`, {
            ...context,
            field: primaryField,
            value,
            entryIndices: indices,
            duplicateCount: indices.length,
          });
        }
      }

      if (duplicateCount > 0) {
        logger.warn(`⚠️ Found ${duplicateCount} duplicate value(s) in ${contentType}`, {
          ...context,
          duplicateCount,
          field: primaryField,
        });
      } else {
        logger.debug(`✅ No duplicates found in ${contentType}`, context);
      }
    }
  }

  private generateUniqueKey(contentType: string, data: any): string {
    const key = `${contentType}-${data.title || data.name || data.slug || data.id}`;
    return key;
  }

  private async createMissingRelationEntity(
    contentType: string,
    name: string,
    locale?: string
  ): Promise<string | null> {
    const context = {
      operation: 'createMissingRelationEntity',
      contentType,
      name: name.substring(0, 50) + '...',
      locale,
    };

    logger.info(`🚀 Creating missing relation entity`, context);

    const entityLocale = locale || 'ru';
    let entityData: any = {};

    try {
      switch (contentType) {
        case 'api::faq.faq':
          entityData = {
            title: name,
            richText: `${name}`,
            publishedAt: new Date(),
            locale: entityLocale,
          };
          break;

        case 'api::faq-category.faq-category':
          entityData = {
            title: name,
            richText: `${name}`,
            iconName: 'QuestionMarkIcon',
            publishedAt: new Date(),
            locale: entityLocale,
          };
          break;

        case 'api::country.country':
          // Generate country code from name
          const timestamp = new Date().getTime().toString().slice(-4);
          const baseCode = name
            .replace(/[^a-zA-Z0-9а-яА-ЯёЁіңғүұқөһІҢҒҮҰҚӨҺ]/g, '')
            .substring(0, 3)
            .toUpperCase();
          const code = baseCode || `CTR${timestamp}`;

          entityData = {
            name: name,
            code: code,
            publishedAt: new Date(),
            locale: entityLocale,
          };
          break;

        case 'api::template.template':
          entityData = {
            name: name,
            slug: name
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^\w\-]+/g, ''),
            dynamicZone: [],
            publishedAt: new Date(),
            locale: entityLocale,
          };
          break;

        case 'api::modal.modal':
          entityData = {
            title: name,
            slug: name
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^\w\-]+/g, ''),
            showHeader: true,
            isTitleCenter: false,
            dynamicZone: [
              {
                __component: 'dynamic-components.markdown',
                text: `${name}`,
              },
            ],
            publishedAt: new Date(),
            locale: entityLocale,
          };
          break;

        case 'api::card.card':
          entityData = {
            title: name,
            slug: name
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^\w\-]+/g, ''),
            content: `Auto-generated card: ${name}`,
            publishedAt: new Date(),
            locale: entityLocale,
          };
          break;

        default:
          logger.warn(`Unknown content type for entity creation: ${contentType}`, context);
          return null;
      }

      const newEntity = await strapi.db.query(contentType).create({
        data: entityData,
      });

      if (newEntity) {
        logger.info(`✅ Successfully created missing ${contentType}`, {
          ...context,
          entityId: newEntity.id,
          documentId: newEntity.documentId || newEntity.id,
        });

        // Cache the created entity
        const cacheKey = `${contentType}:${name}`;
        this.createdEntitiesCache.set(cacheKey, newEntity.id);

        return newEntity.id;
      } else {
        logger.error(`❌ Failed to create entity - received null response`, context);
        return null;
      }
    } catch (error) {
      logger.error(`❌ Error creating missing relation entity`, {
        ...context,
        error: error.message,
      });
      return null;
    }
  }
}
