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
  // Current processing path for error tracking
  private currentProcessingPath: string = '';

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
          'api::modal.modal',
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
        firstLocale === 'default' ? undefined : firstLocale,
        options.status,
        contentType
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
          } else if (
            error.message?.includes('Document with id') &&
            error.message?.includes('not found')
          ) {
            // Handle "Document with id not found" errors - likely unprocessed modal references
            logger.error(`❌ Document not found error - possible unprocessed modal reference`, {
              ...context,
              error: error.message,
              hint: 'This usually indicates a modal reference was not properly converted to an ID',
            });

            // Try to extract the problematic ID from the error message
            const idMatch = error.message.match(/Document with id "([^"]+)"/);
            if (idMatch) {
              const problematicId = idMatch[1];
              logger.error(`❌ Problematic ID found in data: "${problematicId}"`, {
                ...context,
                problematicId,
                suggestion: 'Check if this is a modal name that should be converted to an ID',
              });

              // Add this to failures with additional context
              this.context.addFailure(
                `Document not found: "${problematicId}" - likely an unprocessed modal reference`,
                {
                  ...versionData,
                  problematicId,
                  hint: 'This modal name was not properly converted to a database ID',
                }
              );
            } else {
              this.context.addFailure(`Document not found error: ${error.message}`, versionData);
            }
            return null;
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
        locale === 'default' ? undefined : locale,
        options.status,
        contentType
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

  private async processEntryData(
    data: any,
    model: Schema.Schema,
    locale?: string,
    status?: 'draft' | 'published',
    contentType?: string
  ): Promise<any> {
    try {
      const processed = { ...data };

      // Clean potential modal string references in the data before processing
      this.cleanModalReferences(processed);

      // НОВАЯ ЛОГИКА: Обрабатываем modal relations ПЕРЕД стандартной обработкой
      logger.debug(`🎯 PRE-PROCESSING modal relations for ${contentType || 'unknown'}`, {
        operation: 'processEntryData',
        contentType,
        locale,
        status,
      });

      await this.processModalRelationsInData(processed, {
        operation: 'processEntryData',
        contentType,
        locale,
        status,
      });

      // Validate and clean relations before processing
      this.validateAndCleanRelations(processed, model);

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

                        // Add enhanced failure information for array items
                        const arrayItemFailureDetails = {
                          attribute: key,
                          relationValue: value,
                          isArrayItem: true,
                          searchDetails:
                            (error as any).searchDetails || 'No search details available',
                          relationAttribute: attr,
                        };

                        this.context.addFailure(
                          `Failed to process relation in ${key}: ${error.message}`,
                          {
                            value,
                            attribute: key,
                          },
                          arrayItemFailureDetails
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

                // Add enhanced failure information using new method
                if (contentType && status) {
                  this.addEnhancedFailure(
                    error,
                    data[key],
                    contentType,
                    status,
                    locale || 'default',
                    key,
                    {
                      attribute: key,
                      relationValue: data[key],
                      relationTarget: (attr as any).target,
                      relationAttribute: attr,
                    }
                  );
                } else {
                  // Fallback to old method
                  const relationFailureDetails = {
                    attribute: key,
                    relationValue: data[key],
                    searchDetails: (error as any).searchDetails || 'No search details available',
                    relationAttribute: attr,
                  };

                  this.context.addFailure(
                    `Failed to process relation in ${key}: ${error.message}`,
                    {
                      value: data[key],
                      attribute: key,
                    },
                    relationFailureDetails
                  );
                }
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
            // Add detailed failure information with search details
            const failureDetails = {
              relationTarget: attr.target,
              searchValue: typeof item === 'string' ? item : JSON.stringify(item),
              arrayIndex: i,
              totalArrayItems: uniqueRelations.length,
              searchDetails: (error as any).searchDetails || 'No search details available',
              locale: currentLocale || 'not specified',
            };

            this.context.addFailure(
              error.message,
              {
                entry: item,
                path: `${context.operation}.${attr.target}.array[${i}]`,
              },
              failureDetails
            );

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

    // Enhanced generic string relation handler for any content type
    if (typeof relationValue === 'string') {
      logger.debug(`🎯 Processing string relation for ${attr.target}: "${relationValue}"`, {
        ...context,
        value: relationValue.substring(0, 50) + '...',
      });

      // Check if this is a modal ID that looks suspicious (unprocessed modal reference)
      if (
        attr.target === 'api::modal.modal' &&
        relationValue.length > 20 &&
        !relationValue.includes(' ')
      ) {
        logger.warn(`🚨 Detected suspicious modal ID: "${relationValue.substring(0, 30)}..."`, {
          ...context,
          suspiciousId: relationValue.substring(0, 30) + '...',
          hint: 'This looks like an unprocessed modal reference',
        });

        if (this.context.options.ignoreMissingRelations) {
          logger.info(`⚠️ Ignoring suspicious modal ID`, context);
          return null;
        } else {
          throw new Error(
            `Suspicious modal ID detected: "${relationValue.substring(0, 50)}..." - likely an unprocessed modal reference`
          );
        }
      }

      // Determine the most likely search field based on content type
      const searchField = this.getSearchFieldForContentType(attr.target);

      logger.debug(`🔍 Using search field "${searchField}" for ${attr.target}`, {
        ...context,
        searchField,
        value: relationValue.substring(0, 30) + '...',
      });

      // Try to find existing entity
      let entityId = await this.findEntityByName(
        attr.target,
        relationValue,
        searchField,
        currentLocale,
        this.context.options.ignoreMissingRelations,
        this.getEntityTypeLabel(attr.target)
      );

      if (entityId) {
        logger.debug(`✅ Found existing entity for ${attr.target}`, {
          ...context,
          entityId,
          value: relationValue.substring(0, 30) + '...',
        });
        return entityId;
      }

      // If not found and creation is enabled, create the missing entity
      if (this.context.options.createMissingEntities) {
        logger.info(`🚀 Creating missing ${attr.target} entity: "${relationValue}"`, {
          ...context,
          value: relationValue.substring(0, 30) + '...',
        });

        try {
          const createdId = await this.createMissingRelationEntity(
            attr.target,
            relationValue,
            currentLocale
          );

          if (createdId) {
            logger.info(`✅ Successfully created ${attr.target} entity`, {
              ...context,
              createdId,
              value: relationValue.substring(0, 30) + '...',
            });
            return createdId;
          }
        } catch (createError) {
          logger.error(`❌ Failed to create ${attr.target} entity`, {
            ...context,
            error: createError.message,
            value: relationValue.substring(0, 30) + '...',
          });

          if (this.context.options.ignoreMissingRelations) {
            return null;
          } else {
            throw new Error(
              `Failed to create ${attr.target} with ${searchField}="${relationValue}": ${createError.message}`
            );
          }
        }
      }

      // If ignoring missing relations, return null
      if (this.context.options.ignoreMissingRelations) {
        logger.warn(`⚠️ Ignoring missing ${attr.target} relation: "${relationValue}"`, {
          ...context,
          value: relationValue.substring(0, 30) + '...',
        });
        return null;
      }

      // Otherwise throw enhanced error with search details
      const enhancedError = new Error(
        `Related entity with ${searchField}='${relationValue}' not found in ${attr.target}`
      );

      // Add search details for debugging
      (enhancedError as any).searchDetails = {
        searchedName: relationValue,
        searchField: searchField,
        contentType: attr.target,
        locale: currentLocale || 'not specified',
        entityType: this.getEntityTypeLabel(attr.target),
      };

      throw enhancedError;
    }

    // Handle legacy specific content type patterns (for backward compatibility)

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

        // Enhanced template search with locale handling
        const templateId = await this.findEntityByNameWithLocaleHandling(
          'api::template.template',
          templateName,
          'name',
          currentLocale || relationValue.locale,
          this.context.options.ignoreMissingRelations,
          'Template'
        );

        if (templateId) {
          logger.info(`✅ Found template: "${templateName}" -> ID: ${templateId}`, context);
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

            const createdTemplateId = await this.createMissingRelationEntity(
              'api::template.template',
              templateName,
              currentLocale || 'ru'
            );

            if (createdTemplateId) {
              logger.info(`✅ Successfully created new template`, {
                ...context,
                name: templateName,
                createdId: createdTemplateId,
              });

              // Добавляем в кэш созданных сущностей
              this.createdEntitiesCache.set(`template:${templateName}`, createdTemplateId);

              return createdTemplateId;
            } else {
              logger.error(`Failed to create template`, {
                ...context,
                name: templateName,
              });

              if (this.context.options.ignoreMissingRelations) {
                return null;
              } else {
                throw new Error(`Failed to create template with name="${templateName}"`);
              }
            }
          } catch (error) {
            logger.error(`Error creating template`, {
              ...context,
              templateName,
              error: error.message,
            });

            if (this.context.options.ignoreMissingRelations) {
              return null;
            } else {
              throw error;
            }
          }
        }

        // If not found and not creating, handle based on options
        if (this.context.options.ignoreMissingRelations) {
          logger.warn(`⚠️ Ignoring missing template: "${templateName}"`, context);
          return null;
        } else {
          throw new Error(`Template not found: "${templateName}"`);
        }
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

  /**
   * Determines the appropriate search field for a given content type
   */
  private getSearchFieldForContentType(contentType: string): string {
    // Map content types to their most likely search fields
    const contentTypeToSearchField: Record<string, string> = {
      'api::faq.faq': 'title',
      'api::faq-category.faq-category': 'title',
      'api::modal.modal': 'title',
      'api::card.card': 'title',
      'api::template.template': 'name',
      'api::country.country': 'name',
      'api::category.category': 'title',
      'api::tag.tag': 'name',
      'api::product.product': 'title',
      'api::service.service': 'title',
      'api::page.page': 'title',
      'api::article.article': 'title',
      'api::news.news': 'title',
      'api::blog.blog': 'title',
      'api::post.post': 'title',
      'api::user.user': 'username',
      'api::author.author': 'name',
      'api::brand.brand': 'name',
      'api::manufacturer.manufacturer': 'name',
    };

    // Return specific mapping if exists, otherwise default to 'title'
    return contentTypeToSearchField[contentType] || 'title';
  }

  /**
   * Gets a human-readable label for a content type
   */
  private getEntityTypeLabel(contentType: string): string {
    const typeLabels: Record<string, string> = {
      'api::faq.faq': 'FAQ',
      'api::faq-category.faq-category': 'FAQ Category',
      'api::modal.modal': 'Modal',
      'api::card.card': 'Card',
      'api::template.template': 'Template',
      'api::country.country': 'Country',
      'api::category.category': 'Category',
      'api::tag.tag': 'Tag',
      'api::product.product': 'Product',
      'api::service.service': 'Service',
      'api::page.page': 'Page',
      'api::article.article': 'Article',
      'api::news.news': 'News',
      'api::blog.blog': 'Blog',
      'api::post.post': 'Post',
      'api::user.user': 'User',
      'api::author.author': 'Author',
      'api::brand.brand': 'Brand',
      'api::manufacturer.manufacturer': 'Manufacturer',
    };

    return typeLabels[contentType] || contentType.split('.').pop() || 'Entity';
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
      operation: 'processComponentItem',
      componentType,
      locale,
    };

    logger.debug(`Processing component item`, {
      ...context,
      hasComponent: !!item.__component,
      originalComponent: item.__component,
      keysCount: Object.keys(item).length,
    });

    // Глубокое копирование для предотвращения изменения оригинального объекта
    const processed = JSON.parse(JSON.stringify(item));
    const componentModel = getModel(componentType);

    if (!componentModel) {
      logger.error(`Component model not found for type: ${componentType}`, context);
      throw new Error(`Component model not found for type: ${componentType}`);
    }

    logger.debug(`Component model found`, {
      ...context,
      modelUid: componentModel.uid,
      attributesCount: Object.keys(componentModel.attributes).length,
    });

    // Специальная обработка для компонентов с modal relations (аналогично template relations)
    await this.processModalRelations(processed, context, locale);

    // НОВАЯ ЛОГИКА: Comprehensive modal processing ПЕРЕД стандартной обработкой
    logger.debug(`🎯 PRE-PROCESSING modal relations in component ${componentType}`, {
      ...context,
      createMissingEntities: this.context.options.createMissingEntities,
      ignoreMissingRelations: this.context.options.ignoreMissingRelations,
    });

    await this.processModalRelationsInData(processed, {
      operation: 'processComponentItem',
      componentType,
      locale,
    });

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

        // ИСПРАВЛЕННАЯ ЛОГИКА: tab.template может быть компонентом ИЛИ просто объектом с template полем
        if (tab.template && typeof tab.template === 'object') {
          logger.debug(`Found template object in tab ${tabIndex + 1}`, {
            ...context,
            tabIndex,
            hasComponent: !!tab.template.__component,
            hasNestedTemplate: !!tab.template.template,
            nestedTemplateType: typeof tab.template.template,
            templateStructure: Object.keys(tab.template).join(', '),
          });

          // Обрабатываем ВНУТРЕННЕЕ поле template - это и есть relation
          // Поддерживаем ОБА варианта: с __component и без него
          if (tab.template.template) {
            let templateName = null;

            if (typeof tab.template.template === 'string') {
              templateName = tab.template.template;
            } else if (tab.template.template && typeof tab.template.template === 'object') {
              if (typeof tab.template.template.template === 'string') {
                templateName = tab.template.template.template;
              } else if (tab.template.template.name) {
                templateName = tab.template.template.name;
              } else if (tab.template.template.title) {
                templateName = tab.template.template.title;
              }
            }

            if (templateName) {
              logger.debug(`Processing nested template relation in tab ${tabIndex + 1}`, {
                ...context,
                templateName: templateName.substring(0, 50) + '...',
                hasComponent: !!tab.template.__component,
                componentType: tab.template.__component || 'no component',
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
                    hasComponent: !!tab.template.__component,
                  });

                  // Присваиваем найденный ID к внутреннему полю
                  tab.template.template = templateId;
                } else {
                  // Template not found, try to create if enabled
                  throw new Error(`Template not found: ${templateName}`);
                }
              } catch (error) {
                logger.warn(`Template not found in tab ${tabIndex + 1}`, {
                  ...context,
                  templateName: templateName.substring(0, 30) + '...',
                  error: error.message,
                  hasComponent: !!tab.template.__component,
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

                      // Присваиваем созданный ID к внутреннему полю
                      tab.template.template = createdTemplateId;
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
                      tab.template.template = null;
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
                  tab.template.template = null;
                } else {
                  throw error;
                }
              }
            }
          } else {
            logger.debug(`Tab ${tabIndex + 1} template object has no nested template field`, {
              ...context,
              tabIndex,
              templateKeys: Object.keys(tab.template).join(', '),
              hasComponent: !!tab.template.__component,
              componentType: tab.template.__component || 'no component',
            });
          }
        } else if (typeof tab.template === 'string') {
          // УСТАРЕВШАЯ ЛОГИКА: если template передается как строка напрямую (не должно быть)
          logger.warn(`Tab ${tabIndex + 1} has string template (deprecated structure)`, {
            ...context,
            tabIndex,
            templateValue: tab.template.substring(0, 30) + '...',
          });

          // Можно оставить старую логику для обратной совместимости
          // или выдать предупреждение и пропустить
          logger.warn(`Skipping deprecated string template structure`, {
            ...context,
            hint: 'Template should be a component, not a string',
          });
        }
      }
    }

    // Специальная обработка для компонентов country-rates
    if (componentType === 'dynamic-components.country-rates' && processed.items) {
      logger.debug('Processing country-rates component with country relations', context);
      logger.debug(`createMissingEntities=${this.context.options.createMissingEntities}`, context);

      // Обрабатываем все items
      for (let itemIndex = 0; itemIndex < processed.items.length; itemIndex++) {
        const item = processed.items[itemIndex];

        logger.debug(`Processing country-rates item ${itemIndex + 1}/${processed.items.length}`, {
          ...context,
          itemIndex,
          hasCountry: !!item.country,
          countryType: typeof item.country,
          countryValue: item.country,
          rate: item.rate,
          isPopular: item.isPopular,
        });

        // Обрабатываем поле country
        if (item.country && typeof item.country === 'string') {
          const countryName = item.country;

          // Проверяем, не является ли это уже documentId
          if (
            countryName.length > 20 &&
            !countryName.includes(' ') &&
            !/[а-яё]/i.test(countryName)
          ) {
            logger.debug(`⏭️ SKIPPING already processed country field (contains documentId)`, {
              ...context,
              countryValue: countryName.substring(0, 30) + '...',
              itemIndex,
              hint: 'This country field already contains a documentId, skipping duplicate processing',
            });
            continue; // Skip this item
          }

          logger.debug(`Processing country relation in item ${itemIndex + 1}`, {
            ...context,
            countryName: countryName.substring(0, 50) + '...',
          });

          try {
            // Ищем страну по названию
            const countryId = await this.findEntityByName(
              'api::country.country',
              countryName,
              'name',
              locale,
              false, // Don't ignore missing - we want to try creating
              'Country'
            );

            if (countryId) {
              logger.debug(`✅ Found existing country for item ${itemIndex + 1}`, {
                ...context,
                countryId,
                countryName: countryName.substring(0, 30) + '...',
              });

              // Присваиваем найденный ID
              item.country = countryId;
            } else {
              // Country not found, try to create if enabled
              throw new Error(`Country not found: ${countryName}`);
            }
          } catch (error) {
            logger.warn(`Country not found in item ${itemIndex + 1}`, {
              ...context,
              countryName: countryName.substring(0, 30) + '...',
              error: error.message,
            });

            if (this.context.options.createMissingEntities) {
              try {
                logger.info(`🚀 Creating missing country for item ${itemIndex + 1}`, {
                  ...context,
                  countryName: countryName.substring(0, 30) + '...',
                });

                const createdCountryId = await this.createMissingRelationEntity(
                  'api::country.country',
                  countryName,
                  locale
                );

                if (createdCountryId) {
                  logger.info(`✅ Created country for item ${itemIndex + 1}`, {
                    ...context,
                    createdCountryId,
                    countryName: countryName.substring(0, 30) + '...',
                  });

                  // Присваиваем созданный ID
                  item.country = createdCountryId;
                } else {
                  throw new Error(`Failed to create country: ${countryName}`);
                }
              } catch (createError) {
                logger.error(`Failed to create country for item ${itemIndex + 1}`, {
                  ...context,
                  countryName: countryName.substring(0, 30) + '...',
                  createError: createError.message,
                });

                if (this.context.options.ignoreMissingRelations) {
                  // Set to null if ignoring missing relations
                  item.country = null;
                } else {
                  throw createError;
                }
              }
            } else if (this.context.options.ignoreMissingRelations) {
              logger.warn(`Ignoring missing country for item ${itemIndex + 1}`, {
                ...context,
                countryName: countryName.substring(0, 30) + '...',
              });

              // Set to null if ignoring missing relations
              item.country = null;
            } else {
              throw error;
            }
          }
        } else if (item.country && typeof item.country === 'object') {
          logger.debug(`Item ${itemIndex + 1} has object country (likely already processed)`, {
            ...context,
            itemIndex,
            countryStructure: Object.keys(item.country).join(', '),
          });
        }
      }
    }

    // Специальная обработка для компонентов faq-mobile
    if (componentType === 'dynamic-components.faq-mobile') {
      logger.debug('Processing faq-mobile component with FAQ and category relations', context);
      logger.debug(`createMissingEntities=${this.context.options.createMissingEntities}`, context);

      // Обрабатываем featured_faqs (relations to api::faq.faq)
      if (processed.featured_faqs && Array.isArray(processed.featured_faqs)) {
        logger.debug(`Processing ${processed.featured_faqs.length} featured FAQs`, context);

        for (let faqIndex = 0; faqIndex < processed.featured_faqs.length; faqIndex++) {
          const faqTitle = processed.featured_faqs[faqIndex];

          if (typeof faqTitle === 'string') {
            // Проверяем, не является ли это уже documentId
            if (faqTitle.length > 20 && !faqTitle.includes(' ') && !/[а-яё]/i.test(faqTitle)) {
              logger.debug(`⏭️ SKIPPING already processed FAQ field (contains documentId)`, {
                ...context,
                faqValue: faqTitle.substring(0, 30) + '...',
                faqIndex,
                hint: 'This FAQ field already contains a documentId, skipping duplicate processing',
              });
              continue; // Skip this FAQ
            }

            logger.debug(
              `Processing featured FAQ ${faqIndex + 1}/${processed.featured_faqs.length}`,
              {
                ...context,
                faqTitle: faqTitle.substring(0, 50) + '...',
              }
            );

            try {
              // Ищем FAQ по title
              const faqId = await this.findEntityByName(
                'api::faq.faq',
                faqTitle,
                'title',
                locale,
                false, // Don't ignore missing - we want to try creating
                'FAQ'
              );

              if (faqId) {
                logger.debug(`✅ Found existing FAQ ${faqIndex + 1}`, {
                  ...context,
                  faqId,
                  faqTitle: faqTitle.substring(0, 30) + '...',
                });

                // Присваиваем найденный ID
                processed.featured_faqs[faqIndex] = faqId;
              } else {
                // FAQ not found, try to create if enabled
                throw new Error(`FAQ not found: ${faqTitle}`);
              }
            } catch (error) {
              logger.warn(`FAQ not found ${faqIndex + 1}`, {
                ...context,
                faqTitle: faqTitle.substring(0, 30) + '...',
                error: error.message,
              });

              if (this.context.options.createMissingEntities) {
                try {
                  logger.info(`🚀 Creating missing FAQ ${faqIndex + 1}`, {
                    ...context,
                    faqTitle: faqTitle.substring(0, 30) + '...',
                  });

                  const createdFaqId = await this.createMissingRelationEntity(
                    'api::faq.faq',
                    faqTitle,
                    locale
                  );

                  if (createdFaqId) {
                    logger.info(`✅ Created FAQ ${faqIndex + 1}`, {
                      ...context,
                      createdFaqId,
                      faqTitle: faqTitle.substring(0, 30) + '...',
                    });

                    // Присваиваем созданный ID
                    processed.featured_faqs[faqIndex] = createdFaqId;
                  } else {
                    throw new Error(`Failed to create FAQ: ${faqTitle}`);
                  }
                } catch (createError) {
                  logger.error(`Failed to create FAQ ${faqIndex + 1}`, {
                    ...context,
                    faqTitle: faqTitle.substring(0, 30) + '...',
                    createError: createError.message,
                  });

                  if (this.context.options.ignoreMissingRelations) {
                    // Set to null if ignoring missing relations
                    processed.featured_faqs[faqIndex] = null;
                  } else {
                    throw createError;
                  }
                }
              } else if (this.context.options.ignoreMissingRelations) {
                logger.warn(`Ignoring missing FAQ ${faqIndex + 1}`, {
                  ...context,
                  faqTitle: faqTitle.substring(0, 30) + '...',
                });

                // Set to null if ignoring missing relations
                processed.featured_faqs[faqIndex] = null;
              } else {
                throw error;
              }
            }
          }
        }

        // Фильтруем null значения из массива
        processed.featured_faqs = processed.featured_faqs.filter((faq) => faq !== null);
      }

      // Обрабатываем categories (relations to api::faq-category.faq-category)
      if (processed.categories && Array.isArray(processed.categories)) {
        logger.debug(`Processing ${processed.categories.length} FAQ categories`, context);

        for (let categoryIndex = 0; categoryIndex < processed.categories.length; categoryIndex++) {
          const categoryTitle = processed.categories[categoryIndex];

          if (typeof categoryTitle === 'string') {
            // Проверяем, не является ли это уже documentId
            if (
              categoryTitle.length > 20 &&
              !categoryTitle.includes(' ') &&
              !/[а-яё]/i.test(categoryTitle)
            ) {
              logger.debug(`⏭️ SKIPPING already processed category field (contains documentId)`, {
                ...context,
                categoryValue: categoryTitle.substring(0, 30) + '...',
                categoryIndex,
                hint: 'This category field already contains a documentId, skipping duplicate processing',
              });
              continue; // Skip this category
            }

            logger.debug(
              `Processing FAQ category ${categoryIndex + 1}/${processed.categories.length}`,
              {
                ...context,
                categoryTitle: categoryTitle.substring(0, 50) + '...',
              }
            );

            try {
              // Ищем категорию по title
              const categoryId = await this.findEntityByName(
                'api::faq-category.faq-category',
                categoryTitle,
                'title',
                locale,
                false, // Don't ignore missing - we want to try creating
                'FAQ Category'
              );

              if (categoryId) {
                logger.debug(`✅ Found existing FAQ category ${categoryIndex + 1}`, {
                  ...context,
                  categoryId,
                  categoryTitle: categoryTitle.substring(0, 30) + '...',
                });

                // Присваиваем найденный ID
                processed.categories[categoryIndex] = categoryId;
              } else {
                // Category not found, try to create if enabled
                throw new Error(`FAQ Category not found: ${categoryTitle}`);
              }
            } catch (error) {
              logger.warn(`FAQ Category not found ${categoryIndex + 1}`, {
                ...context,
                categoryTitle: categoryTitle.substring(0, 30) + '...',
                error: error.message,
              });

              if (this.context.options.createMissingEntities) {
                try {
                  logger.info(`🚀 Creating missing FAQ category ${categoryIndex + 1}`, {
                    ...context,
                    categoryTitle: categoryTitle.substring(0, 30) + '...',
                  });

                  const createdCategoryId = await this.createMissingRelationEntity(
                    'api::faq-category.faq-category',
                    categoryTitle,
                    locale
                  );

                  if (createdCategoryId) {
                    logger.info(`✅ Created FAQ category ${categoryIndex + 1}`, {
                      ...context,
                      createdCategoryId,
                      categoryTitle: categoryTitle.substring(0, 30) + '...',
                    });

                    // Присваиваем созданный ID
                    processed.categories[categoryIndex] = createdCategoryId;
                  } else {
                    throw new Error(`Failed to create FAQ Category: ${categoryTitle}`);
                  }
                } catch (createError) {
                  logger.error(`Failed to create FAQ category ${categoryIndex + 1}`, {
                    ...context,
                    categoryTitle: categoryTitle.substring(0, 30) + '...',
                    createError: createError.message,
                  });

                  if (this.context.options.ignoreMissingRelations) {
                    // Set to null if ignoring missing relations
                    processed.categories[categoryIndex] = null;
                  } else {
                    throw createError;
                  }
                }
              } else if (this.context.options.ignoreMissingRelations) {
                logger.warn(`Ignoring missing FAQ category ${categoryIndex + 1}`, {
                  ...context,
                  categoryTitle: categoryTitle.substring(0, 30) + '...',
                });

                // Set to null if ignoring missing relations
                processed.categories[categoryIndex] = null;
              } else {
                throw error;
              }
            }
          }
        }

        // Фильтруем null значения из массива
        processed.categories = processed.categories.filter((category) => category !== null);
      }
    }

    // Обрабатываем все поля компонента
    logger.debug(`Processing component attributes`, {
      ...context,
      attributesCount: Object.keys(componentModel.attributes).length,
    });

    for (const [key, attr] of Object.entries(componentModel.attributes)) {
      if (!processed[key]) continue;

      logger.debug(`Processing component attribute: ${key}`, {
        ...context,
        attributeKey: key,
        isMediaAttribute: isMediaAttribute(attr),
        isRelationAttribute: isRelationAttribute(attr),
      });

      try {
        if (isMediaAttribute(attr)) {
          const allowedTypes = (attr as Schema.Attribute.Media).allowedTypes || ['any'];
          processed[key] = await this.processMedia(processed[key], allowedTypes);
        } else if (isRelationAttribute(attr)) {
          processed[key] = await this.processRelation(processed[key], attr, locale);
        }
      } catch (error) {
        logger.error(`Failed to process component attribute: ${key}`, {
          ...context,
          attributeKey: key,
          error: error.message,
        });

        if (this.context.options.ignoreMissingRelations) {
          logger.warn(`Ignoring failed attribute processing: ${key}`, context);
          // Keep the original value if processing fails
        } else {
          throw error;
        }
      }
    }

    logger.debug(`Component item processing complete`, {
      ...context,
      resultKeysCount: Object.keys(processed).length,
      hasResultComponent: !!processed.__component,
      resultComponent: processed.__component,
    });

    return processed;
  }

  private async processDynamicZone(items: any[], locale?: string): Promise<any[]> {
    const context = {
      operation: 'processDynamicZone',
      locale,
      itemsCount: items.length,
    };

    logger.debug(`Processing dynamic zone with ${items.length} items`, context);

    const processedItems = await Promise.all(
      items.map(async (item, index) => {
        const itemContext = {
          ...context,
          itemIndex: index,
          componentType: item.__component,
        };

        logger.debug(`Processing dynamic zone item ${index + 1}/${items.length}`, itemContext);

        try {
          // processComponentItem returns the full processed object including __component
          const processedItem = await this.processComponentItem(item, item.__component, locale);

          logger.debug(`Successfully processed dynamic zone item ${index + 1}`, {
            ...itemContext,
            hasComponent: !!processedItem.__component,
            keysCount: Object.keys(processedItem).length,
          });

          return processedItem;
        } catch (error) {
          logger.error(`Failed to process dynamic zone item ${index + 1}`, {
            ...itemContext,
            error: error.message,
          });

          // If processing fails, we still want to keep the original item structure
          if (this.context.options.ignoreMissingRelations) {
            logger.warn(`Keeping original item due to processing error`, itemContext);
            return item;
          } else {
            throw error;
          }
        }
      })
    );

    logger.debug(`Dynamic zone processing complete`, {
      ...context,
      processedItemsCount: processedItems.length,
      originalItemsCount: items.length,
    });

    return processedItems;
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

    // Fix background color values recursively
    this.fixBackgroundColors(sanitized);

    return sanitized;
  }

  private fixBackgroundColors(obj: any): void {
    if (!obj || typeof obj !== 'object') {
      return;
    }

    // Mapping of invalid color values to valid ones
    const colorMapping: Record<string, string> = {
      card: 'main.white',
      secondaryGray: 'secondary.gray',
      primaryGray: 'main.gray',
      whiteCard: 'main.white',
      grayCard: 'main.gray',
      blackCard: 'main.black',
      // Add more mappings as needed
    };

    if (Array.isArray(obj)) {
      obj.forEach((item) => this.fixBackgroundColors(item));
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      if (key === 'backgroundColors' && typeof value === 'string') {
        if (colorMapping[value]) {
          logger.debug(`🎨 Fixing background color: ${value} -> ${colorMapping[value]}`);
          obj[key] = colorMapping[value];
        }
      } else if (typeof value === 'object' && value !== null) {
        this.fixBackgroundColors(value);
      }
    }
  }

  private cleanModalReferences(obj: any): void {
    if (!obj || typeof obj !== 'object') {
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach((item) => this.cleanModalReferences(item));
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      if (key === 'modal' && typeof value === 'string') {
        // ОБНОВЛЕННАЯ ЛОГИКА: Больше не устанавливаем modal в null
        // Это теперь обрабатывается processModalRelationsInData
        logger.debug(
          `🔍 Found modal reference: "${value.substring(0, 50)}..." - will be processed by modal relations handler`,
          {
            key,
            value: value.substring(0, 50) + '...',
            hint: 'Modal relation will be handled by processModalRelationsInData',
          }
        );
        // НЕ УСТАНАВЛИВАЕМ obj[key] = null;
      } else if (typeof value === 'object' && value !== null) {
        this.cleanModalReferences(value);
      }
    }
  }

  private validateAndCleanRelations(data: any, model: Schema.Schema): void {
    if (!data || typeof data !== 'object') {
      return;
    }

    for (const [key, attr] of Object.entries(model.attributes)) {
      if (!data[key] || !isRelationAttribute(attr)) continue;

      try {
        if (Array.isArray(data[key])) {
        } else if (typeof data[key] === 'string') {
          // Check if it looks like an invalid ID
          if (data[key].length > 30 || data[key].includes(' ') || /[а-яё]/i.test(data[key])) {
            logger.warn(`🚨 Removing invalid relation ID: "${data[key].substring(0, 30)}..."`, {
              field: key,
              contentType: model.uid,
              hint: 'This looks like a name instead of an ID',
            });
            data[key] = null;
          }
        }
      } catch (error) {
        logger.error(`Error validating relation field ${key}`, {
          error: error.message,
          field: key,
          contentType: model.uid,
        });
        // Set to null to prevent further errors
        data[key] = null;
      }
    }
  }

  /**
   * Обработка modal relations по аналогии с template relations
   * Специальная логика для компонентов, содержащих modal поля
   */
  private async processModalRelations(
    processed: any,
    context: any,
    locale?: string
  ): Promise<void> {
    const processModalsRecursively = async (obj: any, path: string = ''): Promise<void> => {
      if (!obj || typeof obj !== 'object') {
        return;
      }

      // Если это массив, обрабатываем каждый элемент
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          await processModalsRecursively(obj[i], `${path}[${i}]`);
        }
        return;
      }

      // Обрабатываем modal поля в объекте
      if (obj.modal && typeof obj.modal === 'string') {
        // ✅ НОВАЯ ПРОВЕРКА: Пропускаем уже обработанные modal поля (documentId)
        if (obj.modal.length > 20 && !obj.modal.includes(' ') && !obj.modal.includes('А-Я')) {
          logger.debug(`⏭️ SKIPPING already processed modal field (contains documentId)`, {
            ...context,
            modalValue: obj.modal.substring(0, 30) + '...',
            modalPath: path,
            hint: 'This modal field already contains a documentId, skipping duplicate processing',
          });
          return; // Skip this modal field
        }

        let modalName = null;
        let modalObject = null;

        // Определяем название модали (аналогично templateObject логике)
        if (typeof obj.modal === 'string') {
          modalName = obj.modal;
        } else if (obj.modal && typeof obj.modal === 'object') {
          if (typeof obj.modal.modal === 'string') {
            modalName = obj.modal.modal;
            modalObject = obj.modal;
          } else if (obj.modal.title) {
            modalName = obj.modal.title;
            modalObject = obj.modal;
          } else if (obj.modal.name) {
            modalName = obj.modal.name;
            modalObject = obj.modal;
          }
        }

        if (modalName) {
          logger.debug(`🎯 Processing modal relation at ${path}`, {
            ...context,
            modalName: modalName.substring(0, 50) + '...',
            hasModalObject: !!modalObject,
            modalPath: path,
          });

          try {
            // Ищем модаль по title с улучшенным поиском (аналогично template)
            const modalId = await this.findEntityByName(
              'api::modal.modal',
              modalName,
              'title',
              locale,
              false, // Don't ignore missing - we want to try creating
              'Modal'
            );

            if (modalId) {
              logger.debug(`✅ Found existing modal at ${path}`, {
                ...context,
                modalId,
                modalName: modalName.substring(0, 30) + '...',
                modalPath: path,
              });

              // Присваиваем найденный ID (аналогично template logic)
              if (typeof obj.modal === 'string') {
                obj.modal = modalId;
              } else if (modalObject) {
                modalObject.modal = modalId;
              }
            } else {
              // Modal not found, try to create if enabled
              throw new Error(`Modal not found: ${modalName}`);
            }
          } catch (error) {
            logger.warn(`Modal not found at ${path}`, {
              ...context,
              modalName: modalName.substring(0, 30) + '...',
              error: error.message,
              modalPath: path,
            });

            if (this.context.options.createMissingEntities) {
              try {
                logger.info(`🚀 Creating missing modal at ${path}`, {
                  ...context,
                  modalName: modalName.substring(0, 30) + '...',
                  modalPath: path,
                });

                const createdModalId = await this.createMissingRelationEntity(
                  'api::modal.modal',
                  modalName,
                  locale
                );

                if (createdModalId) {
                  logger.info(`✅ Created modal at ${path}`, {
                    ...context,
                    createdModalId,
                    modalName: modalName.substring(0, 30) + '...',
                    modalPath: path,
                  });

                  // Присваиваем созданный ID (аналогично template logic)
                  if (typeof obj.modal === 'string') {
                    obj.modal = createdModalId;
                  } else if (modalObject) {
                    modalObject.modal = createdModalId;
                  }
                } else {
                  throw new Error(`Failed to create modal: ${modalName}`);
                }
              } catch (createError) {
                logger.error(`Failed to create modal at ${path}`, {
                  ...context,
                  modalName: modalName.substring(0, 30) + '...',
                  createError: createError.message,
                  modalPath: path,
                });

                if (this.context.options.ignoreMissingRelations) {
                  // Set to null if ignoring missing relations
                  if (typeof obj.modal === 'string') {
                    obj.modal = null;
                  } else if (modalObject) {
                    modalObject.modal = null;
                  }
                } else {
                  throw createError;
                }
              }
            } else if (this.context.options.ignoreMissingRelations) {
              logger.warn(`Ignoring missing modal at ${path}`, {
                ...context,
                modalName: modalName.substring(0, 30) + '...',
                modalPath: path,
              });

              // Set to null if ignoring missing relations
              if (typeof obj.modal === 'string') {
                obj.modal = null;
              } else if (modalObject) {
                modalObject.modal = null;
              }
            } else {
              throw error;
            }
          }
        }
      }

      // Рекурсивно обрабатываем все поля объекта
      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object') {
          await processModalsRecursively(value, path ? `${path}.${key}` : key);
        }
      }
    };

    try {
      await processModalsRecursively(processed, 'component');
      logger.debug(`✅ Modal relations processing complete`, context);
    } catch (error) {
      logger.error(`❌ Error in processModalRelations`, {
        ...context,
        error: error.message,
      });

      if (!this.context.options.ignoreMissingRelations) {
        throw error;
      }
    }
  }

  private async processButtonsWithModals(item: any, context: any): Promise<void> {
    if (!item || typeof item !== 'object') {
      return;
    }

    const locale = context.locale;

    logger.debug(`🔍 Starting processButtonsWithModals`, {
      ...context,
      createMissingEntities: this.context.options.createMissingEntities,
      ignoreMissingRelations: this.context.options.ignoreMissingRelations,
      itemKeys: Object.keys(item).join(', '),
    });

    // Рекурсивная функция для поиска кнопок в объекте
    const processButtonsRecursively = async (obj: any, path: string = ''): Promise<void> => {
      if (!obj || typeof obj !== 'object') {
        return;
      }

      // Если это массив, обрабатываем каждый элемент
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          await processButtonsRecursively(obj[i], `${path}[${i}]`);
        }
        return;
      }

      // Проверяем, является ли текущий объект компонентом button
      if (obj.__component === 'dynamic-components.button') {
        logger.debug(`🔍 Found button component at ${path}`, {
          ...context,
          buttonText: obj.text || 'No text',
          hasModal: !!obj.modal,
          buttonPath: path,
        });

        // Обрабатываем модальное окно в отдельном компоненте button
        if (obj && typeof obj === 'object' && obj.modal) {
          if (typeof obj.modal === 'string') {
            logger.debug(`🎯 Processing modal in button component at ${path}`, {
              ...context,
              modalName: obj.modal.substring(0, 50) + '...',
              buttonText: obj.text || 'No text',
            });

            try {
              logger.debug(`🔍 Searching for modal`, {
                ...context,
                modalName: obj.modal,
                searchField: 'title',
                locale,
                createMissingEntities: this.context.options.createMissingEntities,
              });

              // Ищем модальное окно по title
              const modalId = await this.findEntityByName(
                'api::modal.modal',
                obj.modal,
                'title',
                locale,
                this.context.options.ignoreMissingRelations,
                'Modal'
              );

              if (modalId) {
                logger.debug(`✅ Found existing modal for button component at ${path}`, {
                  ...context,
                  modalId,
                  modalName: obj.modal.substring(0, 30) + '...',
                });
                obj.modal = modalId;
              } else if (this.context.options.createMissingEntities) {
                // Создаем новое модальное окно
                try {
                  logger.info(`🚀 Creating missing modal for button component at ${path}`, {
                    ...context,
                    modalName: obj.modal.substring(0, 30) + '...',
                  });

                  const createdModalId = await this.createMissingRelationEntity(
                    'api::modal.modal',
                    obj.modal,
                    locale
                  );

                  if (createdModalId) {
                    logger.info(`✅ Created modal for button component at ${path}`, {
                      ...context,
                      createdModalId,
                      modalName: obj.modal.substring(0, 30) + '...',
                    });
                    obj.modal = createdModalId;
                  } else {
                    throw new Error(`Failed to create modal: ${obj.modal}`);
                  }
                } catch (createError) {
                  logger.error(`Failed to create modal for button component at ${path}`, {
                    ...context,
                    modalName: obj.modal.substring(0, 30) + '...',
                    createError: createError.message,
                  });

                  if (this.context.options.ignoreMissingRelations) {
                    obj.modal = null;
                  } else {
                    throw createError;
                  }
                }
              } else if (this.context.options.ignoreMissingRelations) {
                logger.warn(`Ignoring missing modal for button component at ${path}`, {
                  ...context,
                  modalName: obj.modal.substring(0, 30) + '...',
                });
                obj.modal = null;
              } else {
                throw new Error(`Modal not found: ${obj.modal}`);
              }
            } catch (error) {
              logger.error(`Error processing modal for button component at ${path}`, {
                ...context,
                modalName: obj.modal.substring(0, 30) + '...',
                error: error.message,
              });

              if (this.context.options.ignoreMissingRelations) {
                obj.modal = null;
              } else {
                throw error;
              }
            }
          } else {
            logger.debug(`Button component at ${path} has non-string modal, skipping`, {
              ...context,
              modalType: typeof obj.modal,
              buttonPath: path,
            });
          }
        }
      }

      // Проверяем, есть ли в объекте поле 'buttons'
      if (obj.buttons && Array.isArray(obj.buttons)) {
        logger.debug(`🔍 Found buttons array at ${path}.buttons`, {
          ...context,
          buttonsCount: obj.buttons.length,
          buttonsPath: path,
        });

        // Обрабатываем каждую кнопку
        for (let buttonIndex = 0; buttonIndex < obj.buttons.length; buttonIndex++) {
          const button = obj.buttons[buttonIndex];
          const buttonPath = `${path}.buttons[${buttonIndex}]`;

          if (button && typeof button === 'object' && button.modal) {
            if (typeof button.modal === 'string') {
              logger.debug(`🎯 Processing modal in button at ${buttonPath}`, {
                ...context,
                modalName: button.modal.substring(0, 50) + '...',
                buttonText: button.text || 'No text',
              });

              try {
                logger.debug(`🔍 Searching for modal in buttons array`, {
                  ...context,
                  modalName: button.modal,
                  searchField: 'title',
                  locale,
                  createMissingEntities: this.context.options.createMissingEntities,
                  buttonIndex: buttonIndex,
                });

                // Ищем модальное окно по title
                const modalId = await this.findEntityByName(
                  'api::modal.modal',
                  button.modal,
                  'title',
                  locale,
                  this.context.options.ignoreMissingRelations,
                  'Modal'
                );

                if (modalId) {
                  logger.debug(`✅ Found existing modal for button at ${buttonPath}`, {
                    ...context,
                    modalId,
                    modalName: button.modal.substring(0, 30) + '...',
                  });
                  button.modal = modalId;
                } else if (this.context.options.createMissingEntities) {
                  // Создаем новое модальное окно
                  try {
                    logger.info(`🚀 Creating missing modal for button at ${buttonPath}`, {
                      ...context,
                      modalName: button.modal.substring(0, 30) + '...',
                    });

                    const createdModalId = await this.createMissingRelationEntity(
                      'api::modal.modal',
                      button.modal,
                      locale
                    );

                    if (createdModalId) {
                      logger.info(`✅ Created modal for button at ${buttonPath}`, {
                        ...context,
                        createdModalId,
                        modalName: button.modal.substring(0, 30) + '...',
                      });
                      button.modal = createdModalId;
                    } else {
                      throw new Error(`Failed to create modal: ${button.modal}`);
                    }
                  } catch (createError) {
                    logger.error(`Failed to create modal for button at ${buttonPath}`, {
                      ...context,
                      modalName: button.modal.substring(0, 30) + '...',
                      createError: createError.message,
                    });

                    if (this.context.options.ignoreMissingRelations) {
                      button.modal = null;
                    } else {
                      throw createError;
                    }
                  }
                } else if (this.context.options.ignoreMissingRelations) {
                  logger.warn(`Ignoring missing modal for button at ${buttonPath}`, {
                    ...context,
                    modalName: button.modal.substring(0, 30) + '...',
                  });
                  button.modal = null;
                } else {
                  throw new Error(`Modal not found: ${button.modal}`);
                }
              } catch (error) {
                logger.error(`Error processing modal for button at ${buttonPath}`, {
                  ...context,
                  modalName: button.modal.substring(0, 30) + '...',
                  error: error.message,
                });

                if (this.context.options.ignoreMissingRelations) {
                  button.modal = null;
                } else {
                  throw error;
                }
              }
            } else {
              logger.debug(`Button at ${buttonPath} has non-string modal, skipping`, {
                ...context,
                modalType: typeof button.modal,
                buttonPath: buttonPath,
              });
            }
          }
        }
      }

      // Обрабатываем модальные окна в обычных объектах кнопок (без __component)
      if (
        obj &&
        typeof obj === 'object' &&
        obj.modal &&
        typeof obj.modal === 'string' &&
        !obj.__component
      ) {
        logger.debug(`🎯 Processing modal in generic button object at ${path}`, {
          ...context,
          modalName: obj.modal.substring(0, 50) + '...',
          buttonText: obj.text || 'No text',
          buttonPath: path,
        });

        try {
          logger.debug(`🔍 Searching for modal in generic button object`, {
            ...context,
            modalName: obj.modal,
            searchField: 'title',
            locale,
            createMissingEntities: this.context.options.createMissingEntities,
          });

          // Ищем модальное окно по title
          const modalId = await this.findEntityByName(
            'api::modal.modal',
            obj.modal,
            'title',
            locale,
            this.context.options.ignoreMissingRelations,
            'Modal'
          );

          if (modalId) {
            logger.debug(`✅ Found existing modal for generic button object at ${path}`, {
              ...context,
              modalId,
              modalName: obj.modal.substring(0, 30) + '...',
            });
            obj.modal = modalId;
          } else if (this.context.options.createMissingEntities) {
            // Создаем новое модальное окно
            try {
              logger.info(`🚀 Creating missing modal for generic button object at ${path}`, {
                ...context,
                modalName: obj.modal.substring(0, 30) + '...',
              });

              const createdModalId = await this.createMissingRelationEntity(
                'api::modal.modal',
                obj.modal,
                locale
              );

              if (createdModalId) {
                logger.info(`✅ Created modal for generic button object at ${path}`, {
                  ...context,
                  createdModalId,
                  modalName: obj.modal.substring(0, 30) + '...',
                });
                obj.modal = createdModalId;
              } else {
                throw new Error(`Failed to create modal: ${obj.modal}`);
              }
            } catch (createError) {
              logger.error(`Failed to create modal for generic button object at ${path}`, {
                ...context,
                modalName: obj.modal.substring(0, 30) + '...',
                createError: createError.message,
              });

              if (this.context.options.ignoreMissingRelations) {
                obj.modal = null;
              } else {
                throw createError;
              }
            }
          } else if (this.context.options.ignoreMissingRelations) {
            logger.warn(`Ignoring missing modal for generic button object at ${path}`, {
              ...context,
              modalName: obj.modal.substring(0, 30) + '...',
            });
            obj.modal = null;
          } else {
            // Last resort: Force creation if this looks like a modal name
            if (obj.modal.length > 10 && (obj.modal.includes(' ') || /[а-яё]/i.test(obj.modal))) {
              logger.warn(
                `🔥 Force creating modal as last resort for: "${obj.modal.substring(0, 30)}..."`,
                {
                  ...context,
                  modalName: obj.modal.substring(0, 30) + '...',
                  hint: 'This should normally be handled by createMissingEntities option',
                }
              );

              try {
                const createdModalId = await this.createMissingRelationEntity(
                  'api::modal.modal',
                  obj.modal,
                  locale
                );

                if (createdModalId) {
                  obj.modal = createdModalId;
                } else {
                  obj.modal = null;
                }
              } catch (forceCreateError) {
                logger.error(`Failed to force create modal`, {
                  ...context,
                  error: forceCreateError.message,
                });
                obj.modal = null;
              }
            } else {
              throw new Error(`Modal not found: ${obj.modal}`);
            }
          }
        } catch (error) {
          logger.error(`Error processing modal for generic button object at ${path}`, {
            ...context,
            modalName: obj.modal.substring(0, 30) + '...',
            error: error.message,
          });

          if (this.context.options.ignoreMissingRelations) {
            obj.modal = null;
          } else {
            throw error;
          }
        }
      }

      // Рекурсивно обрабатываем все вложенные объекты и массивы
      for (const [key, value] of Object.entries(obj)) {
        if (key !== 'buttons' && typeof value === 'object' && value !== null) {
          const newPath = path ? `${path}.${key}` : key;

          // Проверяем, является ли это поле button компонентом (может быть одиночным или массивом)
          if (
            (key === 'button' ||
              key === 'desktopButtons' ||
              key === 'mobileButtons' ||
              key === 'desktopButton' ||
              key === 'mobileButton' ||
              key === 'responsiveButtons' ||
              key === 'bannerButtons') &&
            value
          ) {
            if (Array.isArray(value)) {
              // Массив button компонентов
              logger.debug(`🔍 Found button array at ${newPath}`, {
                ...context,
                buttonsCount: value.length,
                buttonPath: newPath,
              });

              for (let buttonIndex = 0; buttonIndex < value.length; buttonIndex++) {
                const buttonComponent = value[buttonIndex];
                const buttonPath = `${newPath}[${buttonIndex}]`;

                logger.debug(`🎯 Processing button array item ${buttonIndex + 1}/${value.length}`, {
                  ...context,
                  buttonIndex,
                  buttonText: buttonComponent?.text || 'No text',
                  hasModal: !!buttonComponent?.modal,
                  modalValue: buttonComponent?.modal,
                  buttonComponent: buttonComponent?.__component || 'no component',
                  buttonPath,
                });

                await processButtonsRecursively(buttonComponent, buttonPath);
              }
            } else {
              // Одиночный button компонент
              logger.debug(`🔍 Found single button at ${newPath}`, {
                ...context,
                hasModal: !!(value as any).modal,
                buttonPath: newPath,
              });
              await processButtonsRecursively(value, newPath);
            }
          } else {
            // Обычная рекурсивная обработка
            await processButtonsRecursively(value, newPath);
          }
        }
      }
    };

    try {
      await processButtonsRecursively(item, 'item');
    } catch (error) {
      logger.error(`Error in processButtonsWithModals`, {
        ...context,
        error: error.message,
      });

      if (!this.context.options.ignoreMissingRelations) {
        throw error;
      }
    }
  }

  /**
   * Enhanced version of findEntityByName with better locale handling for templates
   */
  private async findEntityByNameWithLocaleHandling(
    contentType: string,
    name: string,
    nameField: string = 'name',
    locale: string | null = null,
    ignoreMissingRelations: boolean = false,
    entityType: string = 'Entity'
  ): Promise<string | null> {
    const context = {
      operation: 'findEntityByNameWithLocaleHandling',
      contentType,
      name: name.substring(0, 50) + '...',
      nameField,
      locale,
    };

    logger.debug(`🔍 Enhanced search for ${entityType} with locale handling`, context);

    // First try the standard findEntityByName
    try {
      const result = await this.findEntityByName(
        contentType,
        name,
        nameField,
        locale,
        true, // Always ignore missing relations in first attempt
        entityType
      );

      if (result) {
        logger.debug(`✅ Found ${entityType} using standard search`, {
          ...context,
          entityId: result,
        });
        return result;
      }
    } catch (error) {
      logger.debug(`Standard search failed: ${error.message}`, context);
    }

    // If not found, try with different locale strategies for templates
    if (contentType === 'api::template.template') {
      const localeStrategies = [
        null, // No locale filter
        'ru', // Default locale
        'en', // English fallback
        'default', // Default keyword
      ];

      for (const searchLocale of localeStrategies) {
        if (searchLocale === locale) continue; // Skip if already tried

        try {
          logger.debug(`🔄 Trying template search with locale: ${searchLocale || 'null'}`, {
            ...context,
            searchLocale: searchLocale || 'null',
          });

          const searchWhere: any = {
            [nameField]: name.trim(),
          };

          // Only add locale filter if specified
          if (searchLocale && searchLocale !== 'default') {
            searchWhere.locale = searchLocale;
          }

          const entity = await strapi.db.query(contentType).findOne({
            where: searchWhere,
          });

          if (entity) {
            logger.info(`✅ Found ${entityType} with locale strategy: ${searchLocale || 'null'}`, {
              ...context,
              entityId: entity.id,
              documentId: entity.documentId,
              foundLocale: entity.locale || 'null',
              foundValue: entity[nameField],
            });
            return entity.documentId || entity.id;
          }
        } catch (searchError) {
          logger.debug(
            `Search with locale ${searchLocale || 'null'} failed: ${searchError.message}`,
            context
          );
        }
      }

      // Try case-insensitive search for templates
      try {
        logger.debug(`🔍 Trying case-insensitive template search`, context);

        const entity = await strapi.db.query(contentType).findOne({
          where: {
            [nameField]: {
              $containsi: name.trim(),
            },
          },
        });

        if (entity) {
          logger.info(`✅ Found ${entityType} with case-insensitive search`, {
            ...context,
            entityId: entity.id,
            documentId: entity.documentId,
            foundLocale: entity.locale || 'null',
            foundValue: entity[nameField],
          });
          return entity.documentId || entity.id;
        }
      } catch (searchError) {
        logger.debug(`Case-insensitive search failed: ${searchError.message}`, context);
      }

      // List available templates for debugging
      try {
        const availableTemplates = await strapi.db.query(contentType).findMany({
          limit: 10,
          select: [nameField, 'locale', 'id', 'documentId'],
        });

        logger.debug(`📋 Available templates (first 10):`, {
          ...context,
          availableCount: availableTemplates.length,
          templates: availableTemplates.map((t) => ({
            id: t.id,
            documentId: t.documentId,
            [nameField]: t[nameField],
            locale: t.locale || 'null',
          })),
        });
      } catch (debugError) {
        logger.debug(`Error listing templates for debug: ${debugError.message}`, context);
      }
    }

    if (ignoreMissingRelations) {
      logger.debug(`⚠️ ${entityType} not found, ignoring due to settings`, context);
      return null;
    } else {
      logger.error(`❌ ${entityType} not found after enhanced search`, context);
      throw new Error(`${entityType} with ${nameField}='${name}' not found in ${contentType}`);
    }
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

      // Strategy 1: Check if model has i18n/localization
      const targetModel = getModel(contentType);
      const isLocalized =
        targetModel?.pluginOptions?.i18n &&
        (targetModel.pluginOptions.i18n as any)?.localized === true;
      const hasDraftAndPublish = targetModel?.options?.draftAndPublish !== false;

      logger.debug(`🌐 Content type info`, {
        ...context,
        isLocalized,
        hasDraftAndPublish,
        hasI18nPlugin: !!targetModel?.pluginOptions?.i18n,
      });

      // Strategy 2: For content types with draft/publish (like modals), use strapi.documents
      if (hasDraftAndPublish) {
        logger.debug(`📄 Using strapi.documents for draft/publish content`, context);

        // Try different statuses and locales
        const statusesToTry = ['published', 'draft'];
        const searchLocales = isLocalized ? ['ru', 'en', 'kk', locale].filter(Boolean) : [null];

        for (const status of statusesToTry) {
          for (const searchLocale of searchLocales) {
            try {
              const filters: any = {
                [nameField]: normalizedName,
              };

              // Only add locale filter for localized content
              if (isLocalized && searchLocale) {
                filters.locale = searchLocale;
              }

              logger.debug(`🎯 Searching documents with status=${status}`, {
                ...context,
                status,
                searchLocale: searchLocale || 'null',
                filters: JSON.stringify(filters),
              });

              entity = await this.services.documents(contentType as any).findFirst({
                filters,
                status: status as any,
              });

              if (entity) {
                logger.info(`✅ Found ${entityType} via documents API`, {
                  ...context,
                  entityId: entity.id,
                  documentId: entity.documentId,
                  foundStatus: status,
                  foundLocale: entity.locale || 'null',
                  foundValue: entity[nameField],
                });
                return entity.documentId;
              }
            } catch (error) {
              logger.debug(
                `Error searching documents with status ${status}, locale ${searchLocale}: ${error.message}`,
                context
              );
            }
          }
        }

        // If not found via documents API, try case-insensitive search
        for (const status of statusesToTry) {
          try {
            logger.debug(`🔍 Case-insensitive search with status=${status}`, context);

            // For case-insensitive search, we need to get all entities and filter manually
            const allEntities = await this.services.documents(contentType as any).findMany({
              filters: {},
              status: status as any,
              limit: 1000, // Increased limit to handle more entities
            });

            for (const candidateEntity of allEntities) {
              const candidateValue = candidateEntity[nameField];
              if (candidateValue && typeof candidateValue === 'string') {
                // Exact match (case-insensitive)
                if (candidateValue.toLowerCase().trim() === normalizedName.toLowerCase()) {
                  logger.info(`✅ Found ${entityType} via case-insensitive search`, {
                    ...context,
                    entityId: candidateEntity.id,
                    documentId: candidateEntity.documentId,
                    foundStatus: status,
                    foundValue: candidateValue,
                    foundLocale: candidateEntity.locale || 'null',
                  });
                  return candidateEntity.documentId;
                }

                // Fuzzy match for entities that might have slight differences
                const normalizedCandidate = candidateValue
                  .toLowerCase()
                  .trim()
                  .replace(/[^\w\s]/g, '') // Remove special characters
                  .replace(/\s+/g, ' '); // Normalize whitespace
                const normalizedSearch = normalizedName
                  .toLowerCase()
                  .trim()
                  .replace(/[^\w\s]/g, '') // Remove special characters
                  .replace(/\s+/g, ' '); // Normalize whitespace

                if (normalizedCandidate === normalizedSearch) {
                  logger.info(`✅ Found ${entityType} via fuzzy match search`, {
                    ...context,
                    entityId: candidateEntity.id,
                    documentId: candidateEntity.documentId,
                    foundStatus: status,
                    foundValue: candidateValue,
                    foundLocale: candidateEntity.locale || 'null',
                    searchType: 'fuzzy-match',
                  });
                  return candidateEntity.documentId;
                }
              }
            }
          } catch (error) {
            logger.debug(
              `Error in case-insensitive search with status ${status}: ${error.message}`,
              context
            );
          }
        }
      } else {
        // For content types WITHOUT draft/publish (like modals with draftAndPublish: false)
        logger.debug(`📄 Using db.query for non-draft/publish content`, context);

        const searchLocales = isLocalized ? ['ru', 'en', 'kk', locale].filter(Boolean) : [null];

        for (const searchLocale of searchLocales) {
          try {
            const searchWhere: any = {
              [nameField]: normalizedName,
            };

            // Only add locale filter for localized content
            if (isLocalized && searchLocale) {
              searchWhere.locale = searchLocale;
            }

            logger.debug(`🎯 Searching non-draft/publish content with db.query`, {
              ...context,
              searchLocale: searchLocale || 'null',
              searchWhere: JSON.stringify(searchWhere),
            });

            entity = await strapi.db.query(contentType).findOne({
              where: searchWhere,
            });

            if (entity) {
              logger.info(`✅ Found ${entityType} via db.query (non-draft/publish)`, {
                ...context,
                entityId: entity.id,
                documentId: entity.documentId,
                foundLocale: entity.locale || 'null',
                foundValue: entity[nameField],
              });
              return entity.documentId || entity.id;
            }
          } catch (error) {
            logger.debug(
              `Error searching non-draft/publish with db.query locale ${searchLocale}: ${error.message}`,
              context
            );
          }
        }

        // Case-insensitive search for non-draft/publish content
        try {
          logger.debug(`🔍 Case-insensitive search for non-draft/publish content`, context);

          const fuzzyWhere: any = {
            [nameField]: {
              $containsi: normalizedName,
            },
          };

          entity = await strapi.db.query(contentType).findOne({
            where: fuzzyWhere,
          });

          if (entity) {
            logger.info(`✅ Found ${entityType} via case-insensitive search (non-draft/publish)`, {
              ...context,
              entityId: entity.id,
              documentId: entity.documentId,
              foundValue: entity[nameField],
              foundLocale: entity.locale || 'null',
            });
            return entity.documentId || entity.id;
          }
        } catch (error) {
          logger.debug(
            `Error in case-insensitive search for non-draft/publish: ${error.message}`,
            context
          );
        }
      }

      // Strategy 3: Enhanced search with proper locale handling using db.query
      const searchLocales = isLocalized
        ? ['ru', 'en', 'kk', 'default', locale].filter(Boolean)
        : [null]; // Non-localized content

      for (const searchLocale of searchLocales) {
        try {
          // Build search criteria
          const searchWhere: any = {
            [nameField]: normalizedName,
          };

          // Only add locale filter for localized content
          if (isLocalized && searchLocale && searchLocale !== 'default') {
            searchWhere.locale = searchLocale;
          } else if (isLocalized && searchLocale === 'default') {
            // For 'default' locale, try both null and 'en' as fallback
            searchWhere.locale = ['en', null];
          }

          logger.debug(`🎯 Searching with db.query`, {
            ...context,
            searchLocale,
            searchWhere: JSON.stringify(searchWhere),
          });

          entity = await strapi.db.query(contentType).findOne({
            where: searchWhere,
          });

          if (entity) {
            logger.debug(`✅ Found entity with db.query locale ${searchLocale}`, {
              ...context,
              entityId: entity.id,
              documentId: entity.documentId,
              foundLocale: entity.locale || 'null',
              foundValue: entity[nameField],
            });
            return entity.documentId || entity.id;
          }
        } catch (error) {
          logger.debug(
            `Error searching with db.query locale ${searchLocale}: ${error.message}`,
            context
          );
        }
      }

      // Strategy 4: Case-insensitive search across all locales
      try {
        const fuzzyWhere: any = {
          [nameField]: {
            $containsi: normalizedName,
          },
        };

        logger.debug(`🔍 Fuzzy search with case-insensitive matching`, {
          ...context,
          fuzzyWhere: JSON.stringify(fuzzyWhere),
        });

        entity = await strapi.db.query(contentType).findOne({
          where: fuzzyWhere,
        });

        if (entity) {
          logger.debug(`✅ Found by fuzzy search (case-insensitive)`, {
            ...context,
            entityId: entity.id,
            documentId: entity.documentId,
            foundValue: entity[nameField],
            foundLocale: entity.locale || 'null',
          });
          return entity.documentId || entity.id;
        }
      } catch (error) {
        logger.debug(`Error in fuzzy search: ${error.message}`, context);
      }

      // Strategy 5: Special handling for countries with name variations
      if (contentType === 'api::country.country') {
        const countryNameVariations = this.getCountryNameVariations(normalizedName);

        logger.debug(`🌍 Trying country name variations`, {
          ...context,
          originalName: normalizedName,
          variations: countryNameVariations,
        });

        for (const variation of countryNameVariations) {
          try {
            for (const searchLocale of searchLocales) {
              const variationWhere: any = {
                [nameField]: variation,
              };

              if (isLocalized && searchLocale && searchLocale !== 'default') {
                variationWhere.locale = searchLocale;
              }

              entity = await strapi.db.query(contentType).findOne({
                where: variationWhere,
              });

              if (entity) {
                logger.debug(`✅ Found country by name variation`, {
                  ...context,
                  entityId: entity.id,
                  documentId: entity.documentId,
                  originalName: normalizedName,
                  foundVariation: variation,
                  foundLocale: entity.locale || 'null',
                });
                return entity.documentId || entity.id;
              }
            }
          } catch (error) {
            logger.debug(
              `Error searching country variation ${variation}: ${error.message}`,
              context
            );
          }
        }
      }

      // Strategy 6: Debug - List available entities to understand what's in the database
      try {
        logger.debug(`🔍 Listing available entities for debugging`, context);

        if (hasDraftAndPublish) {
          // For draft/publish content, show both statuses
          const publishedEntities = await this.services.documents(contentType as any).findMany({
            filters: {},
            status: 'published',
            limit: 5,
          });

          const draftEntities = await this.services.documents(contentType as any).findMany({
            filters: {},
            status: 'draft',
            limit: 5,
          });

          logger.debug(`📋 Available entities (published):`, {
            ...context,
            count: publishedEntities.length,
            entities: publishedEntities.map((e) => ({
              id: e.id,
              documentId: e.documentId,
              [nameField]: e[nameField],
              locale: e.locale || 'null',
            })),
          });

          logger.debug(`📋 Available entities (draft):`, {
            ...context,
            count: draftEntities.length,
            entities: draftEntities.map((e) => ({
              id: e.id,
              documentId: e.documentId,
              [nameField]: e[nameField],
              locale: e.locale || 'null',
            })),
          });
        } else {
          const availableEntities = await strapi.db.query(contentType).findMany({
            limit: 10,
            select: [nameField, 'locale', 'id', 'documentId'],
          });

          logger.debug(`📋 Available entities sample (first 10):`, {
            ...context,
            availableCount: availableEntities.length,
            entities: availableEntities.map((e) => ({
              id: e.id,
              documentId: e.documentId,
              [nameField]: e[nameField],
              locale: e.locale || 'null',
            })),
          });
        }
      } catch (debugError) {
        logger.debug(`Error listing entities for debug: ${debugError.message}`, context);
      }

      // Strategy 7: For templates, also try searching by slug
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

      // Strategy 8: Ultra-aggressive search - get ALL entities and find any match
      try {
        logger.debug(`🚨 ULTRA-AGGRESSIVE search - scanning ALL entities`, context);

        let allEntities = [];

        if (hasDraftAndPublish) {
          // Get all published and draft entities
          const published = await this.services.documents(contentType as any).findMany({
            filters: {},
            status: 'published',
            limit: 2000,
          });
          const draft = await this.services.documents(contentType as any).findMany({
            filters: {},
            status: 'draft',
            limit: 2000,
          });
          allEntities = [...published, ...draft];
        } else {
          allEntities = await strapi.db.query(contentType).findMany({
            limit: 2000,
          });
        }

        logger.debug(`🔍 Scanning ${allEntities.length} entities for ultra-aggressive match`, {
          ...context,
          totalEntities: allEntities.length,
        });

        for (const candidateEntity of allEntities) {
          const candidateValue = candidateEntity[nameField];
          if (candidateValue && typeof candidateValue === 'string') {
            const candidateNormalized = candidateValue.toLowerCase().trim();
            const searchNormalized = normalizedName.toLowerCase().trim();

            // Ultra-loose matching
            if (
              candidateNormalized === searchNormalized ||
              candidateNormalized.includes(searchNormalized) ||
              searchNormalized.includes(candidateNormalized) ||
              candidateValue === normalizedName ||
              candidateValue.trim() === normalizedName.trim()
            ) {
              logger.info(`🎯 ULTRA-AGGRESSIVE MATCH FOUND!`, {
                ...context,
                entityId: candidateEntity.id,
                documentId: candidateEntity.documentId,
                foundValue: candidateValue,
                searchValue: normalizedName,
                foundLocale: candidateEntity.locale || 'null',
                matchType: 'ultra-aggressive',
                candidateNormalized,
                searchNormalized,
              });
              return candidateEntity.documentId || candidateEntity.id;
            }
          }
        }

        // If still not found, log the first few entities for debugging
        if (allEntities.length > 0) {
          logger.warn(`🚨 NO MATCH FOUND - Here are first 10 entities for comparison:`, {
            ...context,
            searchValue: normalizedName,
            sampleEntities: allEntities.slice(0, 10).map((e) => ({
              id: e.id,
              documentId: e.documentId,
              [nameField]: e[nameField],
              locale: e.locale || 'null',
            })),
          });
        }
      } catch (error) {
        logger.error(`Error in ultra-aggressive search: ${error.message}`, context);
      }

      // Entity not found - prepare detailed error information
      const searchDetails = {
        searchedName: normalizedName,
        searchField: nameField,
        contentType: contentType,
        isLocalized: isLocalized,
        hasDraftAndPublish: hasDraftAndPublish,
        searchedLocales: isLocalized ? searchLocales.filter((l) => l !== null) : ['non-localized'],
        triedVariations:
          contentType === 'api::country.country'
            ? this.getCountryNameVariations(normalizedName)
            : [normalizedName],
        hasI18nPlugin: !!targetModel?.pluginOptions?.i18n,
        draftAndPublish: targetModel?.options?.draftAndPublish,
      };

      logger.warn(
        `❌ Related entity with ${nameField}='${normalizedName.substring(0, 30)}...' not found in ${contentType} (checked both published and draft)`,
        { ...context, searchDetails }
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

        // Create enhanced error with detailed information
        const enhancedError = new Error(
          `Related entity with ${nameField}='${normalizedName.substring(0, 50)}${normalizedName.length > 50 ? '...' : ''}' not found in ${contentType} (checked both published and draft)`
        );

        // Add search details to error for better debugging
        (enhancedError as any).searchDetails = searchDetails;

        throw enhancedError;
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

  /**
   * Get country name variations for better matching
   */
  private getCountryNameVariations(countryName: string): string[] {
    // Simple approach: just return the original name
    return [countryName];
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

  /**
   * Build detailed path for error tracking
   */
  private buildDetailedPath(
    contentType: string,
    status: 'draft' | 'published',
    locale: string,
    additionalPath: string = ''
  ): string {
    const basePath = `${contentType}.${status}.${locale}`;
    return additionalPath ? `${basePath}.${additionalPath}` : basePath;
  }

  /**
   * Add enhanced failure with detailed path information
   */
  private addEnhancedFailure(
    error: Error,
    entry: any,
    contentType: string,
    status: 'draft' | 'published',
    locale: string,
    fieldPath: string = '',
    additionalDetails: any = {}
  ): void {
    const fullPath = this.buildDetailedPath(contentType, status, locale, fieldPath);

    const enhancedDetails = {
      ...additionalDetails,
      contentType,
      status,
      locale,
      fieldPath,
      searchDetails: (error as any).searchDetails,
      timestamp: new Date().toISOString(),
    };

    this.context.addFailure(
      error.message,
      {
        entry,
        path: fullPath,
      },
      enhancedDetails
    );
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
      // Get the target model to understand its structure
      const targetModel = getModel(contentType);
      if (!targetModel) {
        logger.error(`❌ Model not found for content type: ${contentType}`, context);
        return null;
      }

      // Generate basic slug for entities that need it
      const slug = name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '');

      // Determine the main field name based on content type
      const mainField = this.getSearchFieldForContentType(contentType);

      // Start with basic entity data
      entityData = {
        [mainField]: name,
        locale: entityLocale,
      };

      // Add publishedAt only if the model supports draft/publish
      if (targetModel.options?.draftAndPublish !== false) {
        entityData.publishedAt = new Date();
      }

      // Add specific fields based on content type
      switch (contentType) {
        case 'api::faq.faq':
          entityData.richText = `Auto-generated FAQ: ${name}`;
          break;

        case 'api::faq-category.faq-category':
          entityData.richText = `Auto-generated FAQ Category: ${name}`;
          entityData.iconName = 'QuestionMarkIcon';
          break;

        case 'api::country.country':
          // Generate country code from name
          const timestamp = new Date().getTime().toString().slice(-4);
          const baseCode = name
            .replace(/[^a-zA-Z0-9а-яА-ЯёЁіңғүұқөһІҢҒҮҰҚӨҺ]/g, '')
            .substring(0, 3)
            .toUpperCase();
          const code = baseCode || `CTR${timestamp}`;

          // Ensure code is unique
          let finalCode = code;
          let codeAttempts = 0;
          while (codeAttempts < 10) {
            try {
              const existingWithCode = await strapi.db.query('api::country.country').findOne({
                where: { code: finalCode },
              });
              if (!existingWithCode) {
                break; // Code is unique
              }
              codeAttempts++;
              finalCode = `${code}${codeAttempts}`;
            } catch (error) {
              logger.debug(`Error checking code uniqueness: ${error.message}`, context);
              break; // Use the current code
            }
          }

          entityData.code = finalCode;
          // Countries don't use publishedAt (draftAndPublish: false)
          delete entityData.publishedAt;
          break;

        case 'api::template.template':
          entityData.slug = slug;
          entityData.dynamicZone = [];
          break;

        case 'api::modal.modal':
          entityData.slug = slug;
          entityData.showHeader = true;
          entityData.isTitleCenter = false;
          entityData.dynamicZone = [
            {
              __component: 'dynamic-components.markdown',
              text: `Auto-generated modal: ${name}`,
            },
          ];
          break;

        case 'api::card.card':
          entityData.slug = slug;
          entityData.content = `Auto-generated card: ${name}`;
          break;

        case 'api::category.category':
          // Check if the model has slug field
          if (targetModel.attributes.slug) {
            entityData.slug = slug;
          }
          // Check if the model has description field
          if (targetModel.attributes.description) {
            entityData.description = `Auto-generated category: ${name}`;
          }
          break;

        case 'api::tag.tag':
          if (targetModel.attributes.slug) {
            entityData.slug = slug;
          }
          if (targetModel.attributes.description) {
            entityData.description = `Auto-generated tag: ${name}`;
          }
          break;

        default:
          // Generic handling for unknown content types
          logger.info(`🔧 Using generic entity creation for ${contentType}`, context);

          // Add common optional fields if they exist in the model
          if (targetModel.attributes.slug) {
            entityData.slug = slug;
          }
          if (targetModel.attributes.description) {
            entityData.description = `Auto-generated: ${name}`;
          }
          if (targetModel.attributes.content) {
            entityData.content = `Auto-generated content: ${name}`;
          }
          if (targetModel.attributes.richText) {
            entityData.richText = `Auto-generated: ${name}`;
          }
          break;
      }

      logger.debug(`📋 Creating entity with data:`, {
        ...context,
        entityData: JSON.stringify(entityData, null, 2),
      });

      const newEntity = await strapi.db.query(contentType).create({
        data: entityData,
      });

      if (newEntity) {
        logger.info(`✅ Successfully created missing ${contentType}`, {
          ...context,
          entityId: newEntity.id,
          documentId: newEntity.documentId || newEntity.id,
          mainField,
          mainValue: entityData[mainField],
        });

        // Cache the created entity with the correct ID
        const cacheKey = `${contentType}:${name}`;
        const entityIdToCache = newEntity.documentId || newEntity.id;
        this.createdEntitiesCache.set(cacheKey, entityIdToCache);

        return newEntity.documentId || newEntity.id;
      } else {
        logger.error(`❌ Failed to create entity - received null response`, context);
        return null;
      }
    } catch (error) {
      logger.error(`❌ Error creating missing relation entity`, {
        ...context,
        error: error.message,
        errorDetails: error.details || 'No details available',
        errorStack: error.stack,
      });
      return null;
    }
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

  /**
   * Обработка modal relations в любых данных (не только компонентах)
   * Вызывается ПЕРЕД стандартной обработкой relation полей
   */
  private async processModalRelationsInData(data: any, context: any): Promise<void> {
    if (!data || typeof data !== 'object') {
      return;
    }

    const locale = context.locale;

    logger.debug(`🔍 STARTING comprehensive modal relations processing`, {
      ...context,
      createMissingEntities: this.context.options.createMissingEntities,
      ignoreMissingRelations: this.context.options.ignoreMissingRelations,
    });

    const processModalsRecursively = async (obj: any, path: string = ''): Promise<void> => {
      if (!obj || typeof obj !== 'object') {
        return;
      }

      // Если это массив, обрабатываем каждый элемент
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          await processModalsRecursively(obj[i], `${path}[${i}]`);
        }
        return;
      }

      // Обрабатываем modal поля в объекте
      if (obj.modal && typeof obj.modal === 'string') {
        // ✅ НОВАЯ ПРОВЕРКА: Пропускаем уже обработанные modal поля (documentId)
        if (obj.modal.length > 20 && !obj.modal.includes(' ') && !obj.modal.includes('А-Я')) {
          logger.debug(`⏭️ SKIPPING already processed modal field (contains documentId)`, {
            ...context,
            modalValue: obj.modal.substring(0, 30) + '...',
            modalPath: path,
            hint: 'This modal field already contains a documentId, skipping duplicate processing',
          });
          return; // Skip this modal field
        }

        logger.info(`🎯 FOUND modal field at ${path}`, {
          ...context,
          modalName: obj.modal.substring(0, 50) + '...',
          modalPath: path,
        });

        try {
          // Ищем модаль по title с улучшенным поиском
          const modalId = await this.findEntityByName(
            'api::modal.modal',
            obj.modal,
            'title',
            locale,
            false, // Don't ignore missing - we want to try creating
            'Modal'
          );

          if (modalId) {
            logger.info(`✅ SUCCESS: Found existing modal at ${path}`, {
              ...context,
              modalId,
              modalName: obj.modal.substring(0, 30) + '...',
              modalPath: path,
            });

            // Присваиваем найденный ID
            obj.modal = modalId;
          } else {
            // Modal not found, try to create if enabled
            throw new Error(`Modal not found: ${obj.modal}`);
          }
        } catch (error) {
          logger.warn(`❌ Modal not found at ${path}`, {
            ...context,
            modalName: obj.modal.substring(0, 30) + '...',
            error: error.message,
            modalPath: path,
          });

          if (this.context.options.createMissingEntities) {
            try {
              logger.info(`🚀 CREATING missing modal at ${path}`, {
                ...context,
                modalName: obj.modal.substring(0, 30) + '...',
                modalPath: path,
              });

              const createdModalId = await this.createMissingRelationEntity(
                'api::modal.modal',
                obj.modal,
                locale
              );

              if (createdModalId) {
                logger.info(`✅ SUCCESS: Created modal at ${path}`, {
                  ...context,
                  createdModalId,
                  modalName: obj.modal.substring(0, 30) + '...',
                  modalPath: path,
                });

                // Присваиваем созданный ID
                obj.modal = createdModalId;
              } else {
                throw new Error(`Failed to create modal: ${obj.modal}`);
              }
            } catch (createError) {
              logger.error(`❌ FAILED to create modal at ${path}`, {
                ...context,
                modalName: obj.modal.substring(0, 30) + '...',
                createError: createError.message,
                modalPath: path,
              });

              if (this.context.options.ignoreMissingRelations) {
                // Set to null if ignoring missing relations
                obj.modal = null;
              } else {
                throw createError;
              }
            }
          } else if (this.context.options.ignoreMissingRelations) {
            logger.warn(`⚠️ IGNORING missing modal at ${path}`, {
              ...context,
              modalName: obj.modal.substring(0, 30) + '...',
              modalPath: path,
            });

            // Set to null if ignoring missing relations
            obj.modal = null;
          } else {
            throw error;
          }
        }
      }

      // Рекурсивно обрабатываем все поля объекта
      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object') {
          await processModalsRecursively(value, path ? `${path}.${key}` : key);
        }
      }
    };

    try {
      await processModalsRecursively(data, 'data');
      logger.info(`✅ COMPLETED comprehensive modal relations processing`, context);
    } catch (error) {
      logger.error(`❌ ERROR in comprehensive modal relations processing`, {
        ...context,
        error: error.message,
      });

      if (!this.context.options.ignoreMissingRelations) {
        throw error;
      }
    }
  }
}
