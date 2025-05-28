"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportProcessor = void 0;
const import_v3_1 = require("../import-v3");
const models_1 = require("../../../utils/models");
const identifiers_1 = require("../../../utils/identifiers");
const file_1 = require("../utils/file");
const logger_1 = require("../../../utils/logger");
class ImportProcessor {
    constructor(context, services, onProgress) {
        this.totalEntries = 0;
        this.processedEntries = 0;
        // Cache для созданных в этом импорте сущностей, чтобы избежать дублирования
        this.createdEntitiesCache = new Map();
        // Current processing path for error tracking
        this.currentProcessingPath = '';
        this.context = context;
        this.services = services;
        this.onProgress = onProgress;
    }
    async process() {
        // Log import options for debugging
        logger_1.logger.info('Starting import process with options:', {
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
            logger_1.logger.info('✅ Entity creation is ENABLED - missing entities will be created');
        }
        else {
            logger_1.logger.warn('❌ Entity creation is DISABLED - missing entities will cause errors');
        }
        const importData = this.context.importData;
        // Check for duplicates in import data
        this.detectDuplicatesInImportData(importData);
        this.totalEntries = Object.values(importData).reduce((count, entries) => count + entries.length, 0);
        this.processedEntries = 0;
        // Report initial progress
        this.reportProgress(0, `Starting import of ${this.totalEntries} entries`);
        let contentTypeIndex = 0;
        const totalContentTypes = Object.keys(importData).length;
        for (const [contentType, entries] of Object.entries(importData)) {
            const context = {
                operation: 'import',
                contentType,
            };
            contentTypeIndex++;
            this.reportProgress((contentTypeIndex / totalContentTypes) * 0.1, // First 10% is for content type initialization
            `Processing content type ${contentType} (${contentTypeIndex}/${totalContentTypes})`);
            const model = (0, models_1.getModel)(contentType);
            if (!model) {
                logger_1.logger.error(`Model not found`, context);
                this.context.addFailure(`Model ${contentType} not found`, contentType);
                continue;
            }
            const idField = model.kind !== 'singleType' ? (0, identifiers_1.getIdentifierField)(model) : undefined;
            logger_1.logger.debug(`Processing entries with identifier field: ${idField}`, context);
            // Import each entry's versions
            let entryIndex = 0;
            for (const entry of entries) {
                entryIndex++;
                this.reportProgress(0.1 + (this.processedEntries / this.totalEntries) * 0.9, // Remaining 90% is for entry processing
                `Processing entry ${entryIndex}/${entries.length} for ${contentType}`);
                try {
                    await this.processEntry(contentType, entry, model, idField);
                }
                catch (error) {
                    logger_1.logger.error(`Failed to import entry`, context, error);
                    if (error.details) {
                        logger_1.logger.debug('Error Details', {
                            ...context,
                            details: JSON.stringify(error.details, null, 2),
                        });
                        this.context.addFailure(error.message || 'Unknown error', entry, error.details);
                    }
                    else {
                        this.context.addFailure(error.message || 'Unknown error', entry);
                    }
                }
                this.processedEntries++;
                this.reportProgress(0.1 + (this.processedEntries / this.totalEntries) * 0.9, `Processed ${this.processedEntries}/${this.totalEntries} entries`);
            }
        }
        // Report completion
        this.reportProgress(1, `Import complete. Processed ${this.processedEntries} entries.`);
        return { failures: this.context.getFailures() };
    }
    reportProgress(progress, message) {
        if (this.onProgress) {
            // Make sure progress is between 0 and 1
            const normalizedProgress = Math.min(Math.max(progress, 0), 1);
            this.onProgress(normalizedProgress, message);
        }
    }
    async processEntry(contentType, entry, model, idField) {
        const context = {
            operation: 'import',
            contentType,
            idField,
        };
        let documentId = null;
        // First handle published versions if they exist
        if (entry.published) {
            logger_1.logger.debug('Processing published version', context);
            documentId = await this.importVersionData(contentType, entry.published, model, {
                status: 'published',
                idField,
            });
        }
        // Then handle draft versions if they exist
        if (entry.draft) {
            logger_1.logger.debug('Processing draft version', context);
            documentId = await this.importVersionData(contentType, entry.draft, model, {
                documentId,
                status: 'draft',
                idField,
            });
        }
        return documentId;
    }
    async importVersionData(contentType, versionData, model, options) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        const context = {
            operation: 'import',
            contentType,
            status: options.status,
            documentId: options.documentId,
        };
        logger_1.logger.debug('Processing version data', context);
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
            logger_1.logger.info(`🔄 Skipping duplicate entry (already processed in this import)`, {
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
            logger_1.logger.debug('Initial existing entry search result', {
                ...context,
                hasIdField: !!options.idField,
                idFieldValue: options.idField ? firstData[options.idField] : 'N/A',
                foundExisting: !!existing,
                existingId: existing === null || existing === void 0 ? void 0 : existing.documentId,
            });
            // If no existing entry found by idField and this is a modal, try searching by title
            if (!existing && contentType === 'api::modal.modal' && firstData.title) {
                logger_1.logger.debug('No existing modal found by idField, trying title search', {
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
                        logger_1.logger.info('✅ Found existing modal by title, will update instead of create', {
                            ...context,
                            title: firstData.title,
                            existingDocumentId: existing.documentId,
                            searchMethod: 'title',
                        });
                    }
                    else {
                        logger_1.logger.debug('❌ No existing modal found by title search', {
                            ...context,
                            title: firstData.title,
                        });
                    }
                }
                catch (titleSearchError) {
                    logger_1.logger.debug('Error searching modal by title', {
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
                    logger_1.logger.debug(`No existing ${contentType} found by idField, trying title search`, {
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
                            logger_1.logger.info(`Found existing ${contentType} by title, will update instead of create`, {
                                ...context,
                                title: firstData.title,
                                existingDocumentId: existing.documentId,
                                locale: firstLocale === 'default' ? 'default' : firstLocale,
                            });
                        }
                    }
                    catch (titleSearchError) {
                        logger_1.logger.debug(`Error searching ${contentType} by title`, {
                            ...context,
                            error: titleSearchError.message,
                        });
                    }
                }
            }
            // Similar logic for templates (which use 'name' instead of 'title')
            if (!existing && contentType === 'api::template.template' && firstData.name) {
                logger_1.logger.debug('No existing template found by idField, trying name search', {
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
                        logger_1.logger.info('Found existing template by name, will update instead of create', {
                            ...context,
                            name: firstData.name,
                            existingDocumentId: existing.documentId,
                            locale: firstLocale === 'default' ? 'default' : firstLocale,
                        });
                    }
                }
                catch (nameSearchError) {
                    logger_1.logger.debug('Error searching template by name', {
                        ...context,
                        error: nameSearchError.message,
                    });
                }
            }
            if (existing) {
                logger_1.logger.debug('Found existing entry', { ...context, idValue: firstData[options.idField] });
            }
            const processedData = await this.processEntryData(firstData, model, firstLocale === 'default' ? undefined : firstLocale, options.status, contentType);
            const sanitizedData = this.sanitizeData(processedData, model);
            if (existing) {
                switch (this.context.options.existingAction) {
                    case import_v3_1.ExistingAction.Skip:
                        if (!this.context.wasDocumentCreatedInThisImport(existing.documentId)) {
                            logger_1.logger.info(`Skipping existing entry`, {
                                ...context,
                                idField: options.idField,
                                idValue: firstData[options.idField],
                            });
                            return existing.documentId;
                        }
                        logger_1.logger.debug('Entry was created in this import, proceeding with update', context);
                    // fall through to update
                    case import_v3_1.ExistingAction.Update:
                        if (options.status === 'draft' && !this.context.options.allowDraftOnPublished) {
                            const existingPublished = await this.services.documents(contentType).findOne({
                                documentId: existing.documentId,
                                status: 'published',
                            });
                            if (existingPublished) {
                                logger_1.logger.warn('Cannot apply draft to existing published entry', context);
                                this.context.addFailure(`Cannot apply draft to existing published entry`, versionData);
                                return null;
                            }
                        }
                        logger_1.logger.debug('Updating existing entry', {
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
                        this.context.recordUpdated(contentType, firstData[options.idField], existing.documentId);
                        processedFirstLocale = true;
                        break;
                    case import_v3_1.ExistingAction.Warn:
                    default:
                        logger_1.logger.warn('Entry already exists', {
                            ...context,
                            idField: options.idField,
                            idValue: firstData[options.idField],
                        });
                        this.context.addFailure(`Entry with ${(_a = options.idField) !== null && _a !== void 0 ? _a : contentType}=${(_b = firstData[options.idField]) !== null && _b !== void 0 ? _b : 'SINGLE_TYPE'} already exists`, versionData);
                        return null;
                }
            }
            else {
                logger_1.logger.debug('Creating new entry', context);
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
                    logger_1.logger.debug('✅ Stored new entry in cache', {
                        ...context,
                        uniqueKey,
                        documentId,
                    });
                }
                catch (error) {
                    // Handle unique constraint violations
                    if (((_e = (_d = (_c = error.details) === null || _c === void 0 ? void 0 : _c.errors) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.message) === 'This attribute must be unique') {
                        const errorDetails = error.details.errors[0];
                        const fieldName = (_f = errorDetails.path) === null || _f === void 0 ? void 0 : _f[0];
                        const fieldValue = errorDetails.value;
                        logger_1.logger.warn(`🔄 Unique constraint violation on ${fieldName}="${fieldValue}", attempting to find existing entity`, context);
                        try {
                            // Try to find existing entity with the same field value
                            const existingEntity = await strapi.db.query(contentType).findOne({
                                where: {
                                    [fieldName]: fieldValue,
                                },
                            });
                            if (existingEntity) {
                                documentId = existingEntity.documentId || existingEntity.id;
                                logger_1.logger.info(`✅ Found existing entity, will update instead of create`, {
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
                                }
                                catch (updateError) {
                                    logger_1.logger.error(`❌ Failed to update existing entity`, {
                                        ...context,
                                        updateError: updateError.message,
                                    });
                                    // Continue with the original documentId
                                }
                            }
                            else {
                                logger_1.logger.error(`❌ Could not find existing entity despite unique constraint violation`, {
                                    ...context,
                                    error: error.message,
                                });
                                this.context.addFailure(`Unique constraint violation: ${error.message}`, versionData);
                                return null;
                            }
                        }
                        catch (findError) {
                            logger_1.logger.error(`❌ Error handling unique constraint violation`, {
                                ...context,
                                findError: findError.message,
                                originalError: error.message,
                            });
                            this.context.addFailure(`Failed to handle unique constraint: ${error.message}`, versionData);
                            return null;
                        }
                    }
                    else if (((_g = error.message) === null || _g === void 0 ? void 0 : _g.includes('Document with id')) &&
                        ((_h = error.message) === null || _h === void 0 ? void 0 : _h.includes('not found'))) {
                        // Handle "Document with id not found" errors - likely unprocessed modal references
                        logger_1.logger.error(`❌ Document not found error - possible unprocessed modal reference`, {
                            ...context,
                            error: error.message,
                            hint: 'This usually indicates a modal reference was not properly converted to an ID',
                        });
                        // Try to extract the problematic ID from the error message
                        const idMatch = error.message.match(/Document with id "([^"]+)"/);
                        if (idMatch) {
                            const problematicId = idMatch[1];
                            logger_1.logger.error(`❌ Problematic ID found in data: "${problematicId}"`, {
                                ...context,
                                problematicId,
                                suggestion: 'Check if this is a modal name that should be converted to an ID',
                            });
                            // Add this to failures with additional context
                            this.context.addFailure(`Document not found: "${problematicId}" - likely an unprocessed modal reference`, {
                                ...versionData,
                                problematicId,
                                hint: 'This modal name was not properly converted to a database ID',
                            });
                        }
                        else {
                            this.context.addFailure(`Document not found error: ${error.message}`, versionData);
                        }
                        return null;
                    }
                    else {
                        // Re-throw non-unique constraint errors
                        logger_1.logger.error(`Error creating entry for ${contentType}`, {
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
            if (processedFirstLocale && locale === firstLocale)
                continue;
            const localeData = versionData[locale];
            // If we're in skip mode
            if (this.context.options.existingAction === import_v3_1.ExistingAction.Skip && documentId) {
                if (!this.context.wasDocumentCreatedInThisImport(documentId)) {
                    if (!this.context.options.allowLocaleUpdates) {
                        logger_1.logger.debug(`Skipping update for existing entry`, localeContext);
                        continue;
                    }
                    // If we're allowing locale updates, check if this locale already exists
                    const existingLocales = new Set();
                    logger_1.logger.debug('Checking existing locales', localeContext);
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
                        var _a;
                        if (version) {
                            existingLocales.add(version.locale || 'default');
                            (_a = version.localizations) === null || _a === void 0 ? void 0 : _a.forEach((loc) => existingLocales.add(loc.locale));
                        }
                    });
                    // If this locale already exists, skip it
                    if (existingLocales.has(locale === 'default' ? 'default' : locale)) {
                        logger_1.logger.debug(`Skipping existing locale`, localeContext);
                        continue;
                    }
                    logger_1.logger.info(`Creating new locale for existing entry`, localeContext);
                }
            }
            logger_1.logger.debug(`Processing locale data`, localeContext);
            const processedLocale = await this.processEntryData(localeData, model, locale === 'default' ? undefined : locale, options.status, contentType);
            const sanitizedLocaleData = this.sanitizeData(processedLocale, model);
            try {
                await this.services.documents(contentType).update({
                    documentId,
                    locale: locale === 'default' ? undefined : locale,
                    data: sanitizedLocaleData,
                    status: options.status,
                });
            }
            catch (error) {
                // Handle unique constraint violations for locale updates
                if (((_l = (_k = (_j = error.details) === null || _j === void 0 ? void 0 : _j.errors) === null || _k === void 0 ? void 0 : _k[0]) === null || _l === void 0 ? void 0 : _l.message) === 'This attribute must be unique') {
                    const errorDetails = error.details.errors[0];
                    const fieldName = (_m = errorDetails.path) === null || _m === void 0 ? void 0 : _m[0];
                    const fieldValue = errorDetails.value;
                    logger_1.logger.warn(`🔄 Unique constraint violation during locale update on ${fieldName}="${fieldValue}"`, localeContext);
                    try {
                        // Check if the conflicting entry is the same document we're trying to update
                        const conflictingEntity = await strapi.db.query(contentType).findOne({
                            where: {
                                [fieldName]: fieldValue,
                                locale: locale === 'default' ? 'en' : locale, // Use 'en' as default for comparison
                            },
                        });
                        if (conflictingEntity) {
                            if (conflictingEntity.documentId === documentId ||
                                conflictingEntity.id === documentId) {
                                // It's the same document, this is likely a harmless update attempt
                                logger_1.logger.info(`✅ Unique constraint is for the same document, update successful`, {
                                    ...localeContext,
                                    conflictingDocumentId: conflictingEntity.documentId || conflictingEntity.id,
                                    currentDocumentId: documentId,
                                });
                                // Continue processing - this is not really an error
                            }
                            else {
                                // Different document with same title - this is a real conflict
                                logger_1.logger.warn(`⚠️ Title "${fieldValue}" already exists in a different ${contentType} document`, {
                                    ...localeContext,
                                    conflictingDocumentId: conflictingEntity.documentId || conflictingEntity.id,
                                    currentDocumentId: documentId,
                                });
                                // Add as a warning but don't fail the import
                                this.context.addFailure(`Title conflict: "${fieldValue}" already exists in ${contentType} for locale ${locale}`, { locale, fieldName, fieldValue, conflictingId: conflictingEntity.id });
                            }
                        }
                        else {
                            // No conflicting entity found, which is strange
                            logger_1.logger.error(`❌ Unique constraint violation but no conflicting entity found`, localeContext);
                            this.context.addFailure(`Unique constraint violation for locale ${locale} on field ${fieldName}: ${fieldValue}`, { locale, fieldName, fieldValue });
                        }
                    }
                    catch (findError) {
                        logger_1.logger.error(`Error while investigating unique constraint violation`, {
                            ...localeContext,
                            findError: findError.message,
                        });
                        this.context.addFailure(`Unique constraint violation for locale ${locale} on field ${fieldName}: ${fieldValue}`, { locale, fieldName, fieldValue });
                    }
                }
                else {
                    // Re-throw other errors
                    logger_1.logger.error(`Error updating locale for ${contentType}`, {
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
    async processEntryData(data, model, locale, status, contentType) {
        try {
            const processed = { ...data };
            // Clean potential modal string references in the data before processing
            this.cleanModalReferences(processed);
            // Validate and clean relations before processing
            this.validateAndCleanRelations(processed, model);
            for (const [key, attr] of Object.entries(model.attributes)) {
                if (!data[key])
                    continue;
                try {
                    if (key === 'localizations') {
                        delete processed[key];
                        continue;
                    }
                    if ((0, models_1.isRelationAttribute)(attr)) {
                        if (Array.isArray(data[key])) {
                            try {
                                // Используем модифицированный processRelation, который может возвращать массив ID
                                const processedRelations = await this.processRelation(data[key], attr, locale);
                                if (Array.isArray(processedRelations)) {
                                    // Если результат - массив ID, используем его
                                    processed[key] = processedRelations;
                                }
                                else {
                                    // Для обратной совместимости со старым кодом, который обрабатывал каждый элемент отдельно
                                    const documentIds = await Promise.all(data[key].map(async (value) => {
                                        try {
                                            return await this.processRelation(value, attr, locale);
                                        }
                                        catch (error) {
                                            logger_1.logger.error(`Failed to process relation array item`, {
                                                error: error.message,
                                                value,
                                                attribute: key,
                                            });
                                            // Add enhanced failure information for array items
                                            const arrayItemFailureDetails = {
                                                attribute: key,
                                                relationValue: value,
                                                isArrayItem: true,
                                                searchDetails: error.searchDetails || 'No search details available',
                                                relationAttribute: attr,
                                            };
                                            this.context.addFailure(`Failed to process relation in ${key}: ${error.message}`, {
                                                value,
                                                attribute: key,
                                            }, arrayItemFailureDetails);
                                            return null;
                                        }
                                    }));
                                    processed[key] = documentIds.filter((id) => id !== null);
                                }
                            }
                            catch (error) {
                                logger_1.logger.error(`Failed to process relation array`, {
                                    error: error.message,
                                    attribute: key,
                                });
                                this.context.addFailure(`Failed to process relation array in ${key}: ${error.message}`, {
                                    value: data[key],
                                    attribute: key,
                                });
                                processed[key] = [];
                            }
                        }
                        else {
                            try {
                                processed[key] = await this.processRelation(data[key], attr, locale);
                            }
                            catch (error) {
                                logger_1.logger.error(`Failed to process relation`, {
                                    error: error.message,
                                    value: data[key],
                                    attribute: key,
                                });
                                // Add enhanced failure information using new method
                                if (contentType && status) {
                                    this.addEnhancedFailure(error, data[key], contentType, status, locale || 'default', key, {
                                        attribute: key,
                                        relationValue: data[key],
                                        relationTarget: attr.target,
                                        relationAttribute: attr,
                                    });
                                }
                                else {
                                    // Fallback to old method
                                    const relationFailureDetails = {
                                        attribute: key,
                                        relationValue: data[key],
                                        searchDetails: error.searchDetails || 'No search details available',
                                        relationAttribute: attr,
                                    };
                                    this.context.addFailure(`Failed to process relation in ${key}: ${error.message}`, {
                                        value: data[key],
                                        attribute: key,
                                    }, relationFailureDetails);
                                }
                                processed[key] = null;
                            }
                        }
                    }
                    else if ((0, models_1.isComponentAttribute)(attr)) {
                        try {
                            processed[key] = await this.processComponent(data[key], attr, locale);
                        }
                        catch (error) {
                            logger_1.logger.error(`Failed to process component`, {
                                error: error.message,
                                attribute: key,
                            });
                            this.context.addFailure(`Failed to process component in ${key}: ${error.message}`, {
                                value: data[key],
                                attribute: key,
                            });
                            processed[key] = null;
                        }
                    }
                    else if ((0, models_1.isDynamicZoneAttribute)(attr)) {
                        try {
                            // Убедимся, что dynamicZone - это массив
                            if (Array.isArray(data[key])) {
                                processed[key] = await this.processDynamicZone(data[key], locale);
                            }
                            else {
                                logger_1.logger.warn(`DynamicZone ${key} is not an array, setting to empty array`, {
                                    operation: 'processEntryData',
                                    receivedType: typeof data[key],
                                });
                                processed[key] = [];
                            }
                        }
                        catch (error) {
                            logger_1.logger.error(`Failed to process dynamicZone: ${error.message}`, {
                                operation: 'processEntryData',
                                key,
                                errorMessage: error.message,
                                errorStack: error.stack,
                            });
                            // Вместо null используем пустой массив
                            processed[key] = [];
                        }
                    }
                    else if ((0, models_1.isMediaAttribute)(attr)) {
                        const allowedTypes = attr.allowedTypes || ['any'];
                        processed[key] = await this.processMedia(data[key], allowedTypes);
                    }
                }
                catch (error) {
                    logger_1.logger.error(`Failed to process attribute ${key}`, {
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
        }
        catch (error) {
            logger_1.logger.error(`Failed to process entry data`, {
                error: error.message,
                stack: error.stack,
            });
            this.context.addFailure(`Failed to process entry data: ${error.message}`, data);
            throw error; // Re-throw to be caught by processEntry
        }
    }
    async processRelation(relationValue, attr, currentLocale) {
        if (!relationValue)
            return null;
        const context = {
            operation: 'import',
            relation: attr.target,
        };
        // Сразу проверяем, включена ли опция createMissingEntities
        logger_1.logger.debug(`Processing relation for ${attr.target}, createMissingEntities=${this.context.options.createMissingEntities}`, context);
        // Добавляем подробное логирование для отслеживания процесса
        logger_1.logger.info(`🔍 Processing relation: target=${attr.target}, value=${JSON.stringify(relationValue)}, createMissingEntities=${this.context.options.createMissingEntities}`, context);
        const targetModel = (0, models_1.getModel)(attr.target);
        if (!targetModel) {
            logger_1.logger.error(`Target model not found`, context);
            return null;
        }
        const targetIdField = (0, identifiers_1.getIdentifierField)(targetModel);
        // Remove duplicates if relationValue is an array
        if (Array.isArray(relationValue)) {
            logger_1.logger.debug(`Processing array of relations for ${attr.target} (${relationValue.length} items)`, context);
            // Check for and remove duplicates from array
            const uniqueRelations = relationValue.filter((value, index, self) => {
                if (typeof value === 'string') {
                    // For strings, normalize by trimming and compare
                    const normalizedValue = value.trim();
                    return (self.findIndex((item) => typeof item === 'string' && item.trim() === normalizedValue) === index);
                }
                else if (value && typeof value === 'object') {
                    // For objects, use id, name, title if available
                    if (value.id) {
                        return (self.findIndex((item) => item && typeof item === 'object' && item.id === value.id) ===
                            index);
                    }
                    else if (value.name) {
                        return (self.findIndex((item) => item &&
                            typeof item === 'object' &&
                            item.name &&
                            item.name.trim() === value.name.trim()) === index);
                    }
                    else if (value.title) {
                        return (self.findIndex((item) => item &&
                            typeof item === 'object' &&
                            item.title &&
                            item.title.trim() === value.title.trim()) === index);
                    }
                }
                return true; // Keep as is if can't compare
            });
            if (uniqueRelations.length !== relationValue.length) {
                logger_1.logger.debug(`Removed ${relationValue.length - uniqueRelations.length} duplicate items from relation array`, context);
            }
            // Process each array item with enhanced error handling
            const results = [];
            for (let i = 0; i < uniqueRelations.length; i++) {
                const item = uniqueRelations[i];
                logger_1.logger.debug(`Processing array item ${i + 1}/${uniqueRelations.length}`, {
                    ...context,
                    item: typeof item === 'string' ? item.substring(0, 50) + '...' : item,
                });
                try {
                    const result = await this.processRelation(item, attr, currentLocale);
                    // Handle case where processRelation returns an array
                    if (Array.isArray(result)) {
                        results.push(...result);
                    }
                    else {
                        results.push(result);
                    }
                }
                catch (error) {
                    logger_1.logger.warn(`Failed to process relation array item ${i + 1}`, {
                        ...context,
                        item: typeof item === 'string' ? item.substring(0, 50) + '...' : item,
                        error: error.message,
                    });
                    // If entity creation is enabled, try to create the missing entity
                    if (this.context.options.createMissingEntities && typeof item === 'string') {
                        try {
                            const createdId = await this.createMissingRelationEntity(attr.target, item, currentLocale);
                            if (createdId) {
                                results.push(createdId);
                                continue;
                            }
                        }
                        catch (createError) {
                            logger_1.logger.warn(`Failed to create missing entity for array item`, {
                                ...context,
                                item,
                                createError: createError.message,
                            });
                        }
                    }
                    // If ignore missing relations is enabled, just skip this item
                    if (this.context.options.ignoreMissingRelations) {
                        results.push(null);
                    }
                    else {
                        // Add detailed failure information with search details
                        const failureDetails = {
                            relationTarget: attr.target,
                            searchValue: typeof item === 'string' ? item : JSON.stringify(item),
                            arrayIndex: i,
                            totalArrayItems: uniqueRelations.length,
                            searchDetails: error.searchDetails || 'No search details available',
                            locale: currentLocale || 'not specified',
                        };
                        this.context.addFailure(error.message, {
                            entry: item,
                            path: `${context.operation}.${attr.target}.array[${i}]`,
                        }, failureDetails);
                        // Re-throw the error to fail the entire import
                        throw error;
                    }
                }
            }
            // Filter out null values and return results array
            const validResults = results.filter((id) => id !== null);
            logger_1.logger.debug(`Array relation processing complete`, {
                ...context,
                totalItems: uniqueRelations.length,
                successfulItems: validResults.length,
                failedItems: results.length - validResults.length,
            });
            return validResults;
        }
        // Enhanced generic string relation handler for any content type
        if (typeof relationValue === 'string') {
            logger_1.logger.debug(`🎯 Processing string relation for ${attr.target}: "${relationValue}"`, {
                ...context,
                value: relationValue.substring(0, 50) + '...',
            });
            // Determine the most likely search field based on content type
            const searchField = this.getSearchFieldForContentType(attr.target);
            logger_1.logger.debug(`🔍 Using search field "${searchField}" for ${attr.target}`, {
                ...context,
                searchField,
                value: relationValue.substring(0, 30) + '...',
            });
            // Try to find existing entity
            let entityId = await this.findEntityByName(attr.target, relationValue, searchField, currentLocale, this.context.options.ignoreMissingRelations, this.getEntityTypeLabel(attr.target));
            if (entityId) {
                logger_1.logger.debug(`✅ Found existing entity for ${attr.target}`, {
                    ...context,
                    entityId,
                    value: relationValue.substring(0, 30) + '...',
                });
                return entityId;
            }
            // If not found and creation is enabled, create the missing entity
            if (this.context.options.createMissingEntities) {
                logger_1.logger.info(`🚀 Creating missing ${attr.target} entity: "${relationValue}"`, {
                    ...context,
                    value: relationValue.substring(0, 30) + '...',
                });
                try {
                    const createdId = await this.createMissingRelationEntity(attr.target, relationValue, currentLocale);
                    if (createdId) {
                        logger_1.logger.info(`✅ Successfully created ${attr.target} entity`, {
                            ...context,
                            createdId,
                            value: relationValue.substring(0, 30) + '...',
                        });
                        return createdId;
                    }
                }
                catch (createError) {
                    logger_1.logger.error(`❌ Failed to create ${attr.target} entity`, {
                        ...context,
                        error: createError.message,
                        value: relationValue.substring(0, 30) + '...',
                    });
                    if (this.context.options.ignoreMissingRelations) {
                        return null;
                    }
                    else {
                        throw new Error(`Failed to create ${attr.target} with ${searchField}="${relationValue}": ${createError.message}`);
                    }
                }
            }
            // If ignoring missing relations, return null
            if (this.context.options.ignoreMissingRelations) {
                logger_1.logger.warn(`⚠️ Ignoring missing ${attr.target} relation: "${relationValue}"`, {
                    ...context,
                    value: relationValue.substring(0, 30) + '...',
                });
                return null;
            }
            // Otherwise throw enhanced error with search details
            const enhancedError = new Error(`Related entity with ${searchField}='${relationValue}' not found in ${attr.target}`);
            // Add search details for debugging
            enhancedError.searchDetails = {
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
            if (typeof relationValue === 'string' ||
                (relationValue.template && typeof relationValue.template === 'string')) {
                const templateName = typeof relationValue === 'string' ? relationValue : relationValue.template;
                const relationType = typeof relationValue === 'string' ? 'direct' : 'nested';
                logger_1.logger.info(`🎯 Processing template relation: type=${relationType}, name="${templateName}"`, context);
                // Поиск template по имени
                const templateId = await this.findEntityByName('api::template.template', templateName, 'name', relationValue.locale, this.context.options.ignoreMissingRelations, 'Template');
                if (templateId) {
                    return templateId;
                }
                // Проверяем кэш созданных в этом импорте сущностей
                const cacheKey = `template:${templateName}`;
                if (this.createdEntitiesCache.has(cacheKey)) {
                    const cachedId = this.createdEntitiesCache.get(cacheKey);
                    logger_1.logger.debug(`Found template in creation cache: ${cachedId}`, context);
                    return cachedId;
                }
                else if (this.context.options.createMissingEntities) {
                    // Создаем новый шаблон с заданным именем
                    try {
                        logger_1.logger.info(`🚀 ATTEMPTING to create missing template with name="${templateName}"`, context);
                        logger_1.logger.debug(`Template creation data will include: name="${templateName}", locale determined from context`, context);
                        // Используем переданный locale или fallback на 'ru'
                        const entityLocale = currentLocale || 'ru';
                        // Создаем данные для нового шаблона
                        const templateData = {
                            name: templateName,
                            dynamicZone: [], // Пустой массив для dynamicZone
                            publishedAt: new Date(),
                            locale: entityLocale,
                        };
                        const newTemplate = await strapi.db.query('api::template.template').create({
                            data: templateData,
                        });
                        if (newTemplate) {
                            logger_1.logger.info(`✅ Successfully created new template with id ${newTemplate.id}`, {
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
                            }
                            else if (relationValue && typeof relationValue === 'object') {
                                relationValue.template = newTemplate.id;
                            }
                            return relationValue;
                        }
                        else {
                            logger_1.logger.error(`Failed to create template in tab`, {
                                ...context,
                                name: templateName,
                            });
                            if (this.context.options.ignoreMissingRelations) {
                                if (typeof relationValue === 'string') {
                                    relationValue = null;
                                }
                                else if (relationValue && typeof relationValue === 'object') {
                                    relationValue.template = null;
                                }
                            }
                            else {
                                throw new Error(`Failed to create template with name="${templateName}" in tab`);
                            }
                        }
                    }
                    catch (error) {
                        logger_1.logger.error(`Error creating template in tab`, {
                            ...context,
                            templateName,
                            error: error.message,
                        });
                        if (this.context.options.ignoreMissingRelations) {
                            if (typeof relationValue === 'string') {
                                relationValue = null;
                            }
                            else if (relationValue && typeof relationValue === 'object') {
                                relationValue.template = null;
                            }
                        }
                        else {
                            throw error;
                        }
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
                const importedId = await this.processEntry(attr.target, matchingEntry, targetModel, targetIdField);
                return importedId;
            }
        }
        // Если включена опция disallowNewRelations и relation не найдена
        if (this.context.options.disallowNewRelations) {
            if (this.context.options.ignoreMissingRelations) {
                logger_1.logger.warn(`Relation not found and new relations are not allowed`, {
                    ...context,
                    relationValue,
                });
                return null;
            }
            else {
                throw new Error(`Relation not found and new relations are not allowed`);
            }
        }
        return null;
    }
    /**
     * Determines the appropriate search field for a given content type
     */
    getSearchFieldForContentType(contentType) {
        // Map content types to their most likely search fields
        const contentTypeToSearchField = {
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
    getEntityTypeLabel(contentType) {
        const typeLabels = {
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
    async processComponent(value, attr, locale) {
        if (Array.isArray(value)) {
            return Promise.all(value.map((item) => this.processComponentItem(item, attr.component, locale)));
        }
        return this.processComponentItem(value, attr.component, locale);
    }
    async processComponentItem(item, componentType, locale) {
        const context = {
            operation: 'processComponentItem',
            componentType,
            locale,
        };
        logger_1.logger.debug(`Processing component item`, {
            ...context,
            hasComponent: !!item.__component,
            originalComponent: item.__component,
            keysCount: Object.keys(item).length,
        });
        // Глубокое копирование для предотвращения изменения оригинального объекта
        const processed = JSON.parse(JSON.stringify(item));
        const componentModel = (0, models_1.getModel)(componentType);
        if (!componentModel) {
            logger_1.logger.error(`Component model not found for type: ${componentType}`, context);
            throw new Error(`Component model not found for type: ${componentType}`);
        }
        logger_1.logger.debug(`Component model found`, {
            ...context,
            modelUid: componentModel.uid,
            attributesCount: Object.keys(componentModel.attributes).length,
        });
        // Обработка кнопок с модальными окнами
        await this.processButtonsWithModals(processed, context);
        // Специальная обработка для компонентов, содержащих template relations
        if (componentType === 'dynamic-components.tab' && processed.tabs) {
            logger_1.logger.debug('Processing tabs component with template relations', context);
            logger_1.logger.debug(`createMissingEntities=${this.context.options.createMissingEntities}`, context);
            // Обрабатываем все tabs
            for (let tabIndex = 0; tabIndex < processed.tabs.length; tabIndex++) {
                const tab = processed.tabs[tabIndex];
                logger_1.logger.debug(`Processing tab ${tabIndex + 1}/${processed.tabs.length}`, {
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
                }
                else if (tab.template && typeof tab.template === 'object') {
                    if (typeof tab.template.template === 'string') {
                        templateName = tab.template.template;
                        templateObject = tab.template;
                    }
                    else if (tab.template.name) {
                        templateName = tab.template.name;
                        templateObject = tab.template;
                    }
                    else if (tab.template.title) {
                        templateName = tab.template.title;
                        templateObject = tab.template;
                    }
                }
                if (templateName) {
                    logger_1.logger.debug(`Processing template relation in tab ${tabIndex + 1}`, {
                        ...context,
                        templateName: templateName.substring(0, 50) + '...',
                        hasTemplateObject: !!templateObject,
                    });
                    try {
                        // Ищем шаблон по имени с улучшенным поиском
                        const templateId = await this.findEntityByName('api::template.template', templateName, 'name', locale, false, // Don't ignore missing - we want to try creating
                        'Template');
                        if (templateId) {
                            logger_1.logger.debug(`✅ Found existing template for tab ${tabIndex + 1}`, {
                                ...context,
                                templateId,
                                templateName: templateName.substring(0, 30) + '...',
                            });
                            // Присваиваем найденный ID
                            if (typeof tab.template === 'string') {
                                tab.template = templateId;
                            }
                            else if (templateObject) {
                                templateObject.template = templateId;
                            }
                        }
                        else {
                            // Template not found, try to create if enabled
                            throw new Error(`Template not found: ${templateName}`);
                        }
                    }
                    catch (error) {
                        logger_1.logger.warn(`Template not found in tab ${tabIndex + 1}`, {
                            ...context,
                            templateName: templateName.substring(0, 30) + '...',
                            error: error.message,
                        });
                        if (this.context.options.createMissingEntities) {
                            try {
                                logger_1.logger.info(`🚀 Creating missing template for tab ${tabIndex + 1}`, {
                                    ...context,
                                    templateName: templateName.substring(0, 30) + '...',
                                });
                                const createdTemplateId = await this.createMissingRelationEntity('api::template.template', templateName, locale);
                                if (createdTemplateId) {
                                    logger_1.logger.info(`✅ Created template for tab ${tabIndex + 1}`, {
                                        ...context,
                                        createdTemplateId,
                                        templateName: templateName.substring(0, 30) + '...',
                                    });
                                    // Присваиваем созданный ID
                                    if (typeof tab.template === 'string') {
                                        tab.template = createdTemplateId;
                                    }
                                    else if (templateObject) {
                                        templateObject.template = createdTemplateId;
                                    }
                                }
                                else {
                                    throw new Error(`Failed to create template: ${templateName}`);
                                }
                            }
                            catch (createError) {
                                logger_1.logger.error(`Failed to create template for tab ${tabIndex + 1}`, {
                                    ...context,
                                    templateName: templateName.substring(0, 30) + '...',
                                    createError: createError.message,
                                });
                                if (this.context.options.ignoreMissingRelations) {
                                    // Set to null if ignoring missing relations
                                    if (typeof tab.template === 'string') {
                                        tab.template = null;
                                    }
                                    else if (templateObject) {
                                        templateObject.template = null;
                                    }
                                }
                                else {
                                    throw createError;
                                }
                            }
                        }
                        else if (this.context.options.ignoreMissingRelations) {
                            logger_1.logger.warn(`Ignoring missing template for tab ${tabIndex + 1}`, {
                                ...context,
                                templateName: templateName.substring(0, 30) + '...',
                            });
                            // Set to null if ignoring missing relations
                            if (typeof tab.template === 'string') {
                                tab.template = null;
                            }
                            else if (templateObject) {
                                templateObject.template = null;
                            }
                        }
                        else {
                            throw error;
                        }
                    }
                }
            }
        }
        // Обрабатываем все поля компонента
        logger_1.logger.debug(`Processing component attributes`, {
            ...context,
            attributesCount: Object.keys(componentModel.attributes).length,
        });
        for (const [key, attr] of Object.entries(componentModel.attributes)) {
            if (!processed[key])
                continue;
            logger_1.logger.debug(`Processing component attribute: ${key}`, {
                ...context,
                attributeKey: key,
                isMediaAttribute: (0, models_1.isMediaAttribute)(attr),
                isRelationAttribute: (0, models_1.isRelationAttribute)(attr),
            });
            try {
                if ((0, models_1.isMediaAttribute)(attr)) {
                    const allowedTypes = attr.allowedTypes || ['any'];
                    processed[key] = await this.processMedia(processed[key], allowedTypes);
                }
                else if ((0, models_1.isRelationAttribute)(attr)) {
                    processed[key] = await this.processRelation(processed[key], attr, locale);
                }
            }
            catch (error) {
                logger_1.logger.error(`Failed to process component attribute: ${key}`, {
                    ...context,
                    attributeKey: key,
                    error: error.message,
                });
                if (this.context.options.ignoreMissingRelations) {
                    logger_1.logger.warn(`Ignoring failed attribute processing: ${key}`, context);
                    // Keep the original value if processing fails
                }
                else {
                    throw error;
                }
            }
        }
        logger_1.logger.debug(`Component item processing complete`, {
            ...context,
            resultKeysCount: Object.keys(processed).length,
            hasResultComponent: !!processed.__component,
            resultComponent: processed.__component,
        });
        return processed;
    }
    async processDynamicZone(items, locale) {
        const context = {
            operation: 'processDynamicZone',
            locale,
            itemsCount: items.length,
        };
        logger_1.logger.debug(`Processing dynamic zone with ${items.length} items`, context);
        const processedItems = await Promise.all(items.map(async (item, index) => {
            const itemContext = {
                ...context,
                itemIndex: index,
                componentType: item.__component,
            };
            logger_1.logger.debug(`Processing dynamic zone item ${index + 1}/${items.length}`, itemContext);
            try {
                // processComponentItem returns the full processed object including __component
                const processedItem = await this.processComponentItem(item, item.__component, locale);
                logger_1.logger.debug(`Successfully processed dynamic zone item ${index + 1}`, {
                    ...itemContext,
                    hasComponent: !!processedItem.__component,
                    keysCount: Object.keys(processedItem).length,
                });
                return processedItem;
            }
            catch (error) {
                logger_1.logger.error(`Failed to process dynamic zone item ${index + 1}`, {
                    ...itemContext,
                    error: error.message,
                });
                // If processing fails, we still want to keep the original item structure
                if (this.context.options.ignoreMissingRelations) {
                    logger_1.logger.warn(`Keeping original item due to processing error`, itemContext);
                    return item;
                }
                else {
                    throw error;
                }
            }
        }));
        logger_1.logger.debug(`Dynamic zone processing complete`, {
            ...context,
            processedItemsCount: processedItems.length,
            originalItemsCount: items.length,
        });
        return processedItems;
    }
    async processMedia(value, allowedTypes = ['any']) {
        const context = {
            operation: 'import',
            mediaType: Array.isArray(value) ? 'array' : 'single',
            allowedTypes,
        };
        if (Array.isArray(value)) {
            logger_1.logger.debug('Processing media array', context);
            const media = [];
            for (const item of value) {
                logger_1.logger.debug('Processing media item', { ...context, url: item });
                const file = await (0, file_1.findOrImportFile)(item, this.context.user, {
                    allowedFileTypes: allowedTypes,
                });
                if (file) {
                    logger_1.logger.debug('Media file processed', { ...context, fileId: file.id });
                    media.push(file.id);
                }
                else {
                    logger_1.logger.warn('Failed to process media file', { ...context, url: item });
                }
            }
            return media;
        }
        else {
            logger_1.logger.debug('Processing single media item', { ...context, url: value });
            const file = await (0, file_1.findOrImportFile)(value, this.context.user, {
                allowedFileTypes: allowedTypes,
            });
            if (file) {
                logger_1.logger.debug('Media file processed', { ...context, fileId: file.id });
                return file.id;
            }
            logger_1.logger.warn('Failed to process media file', { ...context, url: value });
            return null;
        }
    }
    findEntryInImportData(relationValue, targetIdField, targetEntries) {
        return (targetEntries.find((entry) => {
            // Check draft version first as it might be the intended target
            if (entry.draft) {
                const draftMatch = this.searchInLocaleData(entry.draft, targetIdField, relationValue);
                if (draftMatch)
                    return true;
            }
            // Then check published version
            if (entry.published) {
                return this.searchInLocaleData(entry.published, targetIdField, relationValue);
            }
            return false;
        }) || null);
    }
    searchInLocaleData(localeDataMap, targetIdField, relationValue) {
        return Object.values(localeDataMap).some((localeData) => this.searchInObject(localeData, targetIdField, relationValue));
    }
    searchInObject(obj, targetIdField, relationValue) {
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
            }
            else if (value && typeof value === 'object') {
                // Search in nested objects (like components)
                if (this.searchInObject(value, targetIdField, relationValue)) {
                    return true;
                }
            }
        }
        return false;
    }
    sanitizeData(data, model) {
        const context = {
            operation: 'import',
            contentType: model.uid,
        };
        if (!data || typeof data !== 'object') {
            logger_1.logger.debug('Skipping sanitization for non-object data', context);
            return data;
        }
        logger_1.logger.debug('Sanitizing data', context);
        const sanitized = { ...data };
        const validAttributes = Object.entries(model.attributes).filter(([_, attr]) => attr.configurable !== false);
        const validAttributeNames = new Set(validAttributes.map(([name]) => name));
        // Remove any fields that aren't in the model
        for (const key of Object.keys(sanitized)) {
            if (!validAttributeNames.has(key)) {
                logger_1.logger.debug(`Removing invalid field: ${key}`, context);
                delete sanitized[key];
            }
        }
        // Fix background color values recursively
        this.fixBackgroundColors(sanitized);
        return sanitized;
    }
    fixBackgroundColors(obj) {
        if (!obj || typeof obj !== 'object') {
            return;
        }
        // Mapping of invalid color values to valid ones
        const colorMapping = {
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
                    logger_1.logger.debug(`🎨 Fixing background color: ${value} -> ${colorMapping[value]}`);
                    obj[key] = colorMapping[value];
                }
            }
            else if (typeof value === 'object' && value !== null) {
                this.fixBackgroundColors(value);
            }
        }
    }
    cleanModalReferences(obj) {
        if (!obj || typeof obj !== 'object') {
            return;
        }
        if (Array.isArray(obj)) {
            obj.forEach((item) => this.cleanModalReferences(item));
            return;
        }
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'modal' && typeof value === 'string') {
                // Check if this looks like a modal name instead of an ID
                if (value.length > 20 || value.includes(' ') || /[а-яё]/i.test(value)) {
                    logger_1.logger.warn(`🚨 Found potential unprocessed modal reference: "${value.substring(0, 50)}..."`, {
                        key,
                        value: value.substring(0, 50) + '...',
                        hint: 'This should have been converted to an ID by processButtonsWithModals',
                    });
                    // Set to null to prevent "Document with id not found" errors
                    // The processButtonsWithModals should handle this conversion
                    obj[key] = null;
                }
            }
            else if (typeof value === 'object' && value !== null) {
                this.cleanModalReferences(value);
            }
        }
    }
    validateAndCleanRelations(data, model) {
        if (!data || typeof data !== 'object') {
            return;
        }
        for (const [key, attr] of Object.entries(model.attributes)) {
            if (!data[key] || !(0, models_1.isRelationAttribute)(attr))
                continue;
            try {
                if (Array.isArray(data[key])) {
                    // Filter out invalid relation values
                    data[key] = data[key].filter((item) => {
                        if (typeof item === 'string') {
                            // Check if it looks like an invalid ID
                            if (item.length > 30 || item.includes(' ') || /[а-яё]/i.test(item)) {
                                logger_1.logger.warn(`🚨 Removing invalid relation ID: "${item.substring(0, 30)}..."`, {
                                    field: key,
                                    contentType: model.uid,
                                    hint: 'This looks like a name instead of an ID',
                                });
                                return false;
                            }
                        }
                        return true;
                    });
                }
                else if (typeof data[key] === 'string') {
                    // Check if it looks like an invalid ID
                    if (data[key].length > 30 || data[key].includes(' ') || /[а-яё]/i.test(data[key])) {
                        logger_1.logger.warn(`🚨 Removing invalid relation ID: "${data[key].substring(0, 30)}..."`, {
                            field: key,
                            contentType: model.uid,
                            hint: 'This looks like a name instead of an ID',
                        });
                        data[key] = null;
                    }
                }
            }
            catch (error) {
                logger_1.logger.error(`Error validating relation field ${key}`, {
                    error: error.message,
                    field: key,
                    contentType: model.uid,
                });
                // Set to null to prevent further errors
                data[key] = null;
            }
        }
    }
    async processButtonsWithModals(item, context) {
        if (!item || typeof item !== 'object') {
            return;
        }
        const locale = context.locale;
        logger_1.logger.debug(`🔍 Starting processButtonsWithModals`, {
            ...context,
            createMissingEntities: this.context.options.createMissingEntities,
            ignoreMissingRelations: this.context.options.ignoreMissingRelations,
            itemKeys: Object.keys(item).join(', '),
        });
        // Рекурсивная функция для поиска кнопок в объекте
        const processButtonsRecursively = async (obj, path = '') => {
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
                logger_1.logger.debug(`🔍 Found button component at ${path}`, {
                    ...context,
                    buttonText: obj.text || 'No text',
                    hasModal: !!obj.modal,
                    buttonPath: path,
                });
                // Обрабатываем модальное окно в отдельном компоненте button
                if (obj && typeof obj === 'object' && obj.modal) {
                    if (typeof obj.modal === 'string') {
                        logger_1.logger.debug(`🎯 Processing modal in button component at ${path}`, {
                            ...context,
                            modalName: obj.modal.substring(0, 50) + '...',
                            buttonText: obj.text || 'No text',
                        });
                        try {
                            logger_1.logger.debug(`🔍 Searching for modal`, {
                                ...context,
                                modalName: obj.modal,
                                searchField: 'title',
                                locale,
                                createMissingEntities: this.context.options.createMissingEntities,
                            });
                            // Ищем модальное окно по title
                            const modalId = await this.findEntityByName('api::modal.modal', obj.modal, 'title', locale, this.context.options.ignoreMissingRelations, 'Modal');
                            if (modalId) {
                                logger_1.logger.debug(`✅ Found existing modal for button component at ${path}`, {
                                    ...context,
                                    modalId,
                                    modalName: obj.modal.substring(0, 30) + '...',
                                });
                                obj.modal = modalId;
                            }
                            else if (this.context.options.createMissingEntities) {
                                // Создаем новое модальное окно
                                try {
                                    logger_1.logger.info(`🚀 Creating missing modal for button component at ${path}`, {
                                        ...context,
                                        modalName: obj.modal.substring(0, 30) + '...',
                                    });
                                    const createdModalId = await this.createMissingRelationEntity('api::modal.modal', obj.modal, locale);
                                    if (createdModalId) {
                                        logger_1.logger.info(`✅ Created modal for button component at ${path}`, {
                                            ...context,
                                            createdModalId,
                                            modalName: obj.modal.substring(0, 30) + '...',
                                        });
                                        obj.modal = createdModalId;
                                    }
                                    else {
                                        throw new Error(`Failed to create modal: ${obj.modal}`);
                                    }
                                }
                                catch (createError) {
                                    logger_1.logger.error(`Failed to create modal for button component at ${path}`, {
                                        ...context,
                                        modalName: obj.modal.substring(0, 30) + '...',
                                        createError: createError.message,
                                    });
                                    if (this.context.options.ignoreMissingRelations) {
                                        obj.modal = null;
                                    }
                                    else {
                                        throw createError;
                                    }
                                }
                            }
                            else if (this.context.options.ignoreMissingRelations) {
                                logger_1.logger.warn(`Ignoring missing modal for button component at ${path}`, {
                                    ...context,
                                    modalName: obj.modal.substring(0, 30) + '...',
                                });
                                obj.modal = null;
                            }
                            else {
                                throw new Error(`Modal not found: ${obj.modal}`);
                            }
                        }
                        catch (error) {
                            logger_1.logger.error(`Error processing modal for button component at ${path}`, {
                                ...context,
                                modalName: obj.modal.substring(0, 30) + '...',
                                error: error.message,
                            });
                            if (this.context.options.ignoreMissingRelations) {
                                obj.modal = null;
                            }
                            else {
                                throw error;
                            }
                        }
                    }
                    else {
                        logger_1.logger.debug(`Button component at ${path} has non-string modal, skipping`, {
                            ...context,
                            modalType: typeof obj.modal,
                            buttonPath: path,
                        });
                    }
                }
            }
            // Проверяем, есть ли в объекте поле 'buttons'
            if (obj.buttons && Array.isArray(obj.buttons)) {
                logger_1.logger.debug(`🔍 Found buttons array at ${path}.buttons`, {
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
                            logger_1.logger.debug(`🎯 Processing modal in button at ${buttonPath}`, {
                                ...context,
                                modalName: button.modal.substring(0, 50) + '...',
                                buttonText: button.text || 'No text',
                            });
                            try {
                                logger_1.logger.debug(`🔍 Searching for modal in buttons array`, {
                                    ...context,
                                    modalName: button.modal,
                                    searchField: 'title',
                                    locale,
                                    createMissingEntities: this.context.options.createMissingEntities,
                                    buttonIndex: buttonIndex,
                                });
                                // Ищем модальное окно по title
                                const modalId = await this.findEntityByName('api::modal.modal', button.modal, 'title', locale, this.context.options.ignoreMissingRelations, 'Modal');
                                if (modalId) {
                                    logger_1.logger.debug(`✅ Found existing modal for button at ${buttonPath}`, {
                                        ...context,
                                        modalId,
                                        modalName: button.modal.substring(0, 30) + '...',
                                    });
                                    button.modal = modalId;
                                }
                                else if (this.context.options.createMissingEntities) {
                                    // Создаем новое модальное окно
                                    try {
                                        logger_1.logger.info(`🚀 Creating missing modal for button at ${buttonPath}`, {
                                            ...context,
                                            modalName: button.modal.substring(0, 30) + '...',
                                        });
                                        const createdModalId = await this.createMissingRelationEntity('api::modal.modal', button.modal, locale);
                                        if (createdModalId) {
                                            logger_1.logger.info(`✅ Created modal for button at ${buttonPath}`, {
                                                ...context,
                                                createdModalId,
                                                modalName: button.modal.substring(0, 30) + '...',
                                            });
                                            button.modal = createdModalId;
                                        }
                                        else {
                                            throw new Error(`Failed to create modal: ${button.modal}`);
                                        }
                                    }
                                    catch (createError) {
                                        logger_1.logger.error(`Failed to create modal for button at ${buttonPath}`, {
                                            ...context,
                                            modalName: button.modal.substring(0, 30) + '...',
                                            createError: createError.message,
                                        });
                                        if (this.context.options.ignoreMissingRelations) {
                                            button.modal = null;
                                        }
                                        else {
                                            throw createError;
                                        }
                                    }
                                }
                                else if (this.context.options.ignoreMissingRelations) {
                                    logger_1.logger.warn(`Ignoring missing modal for button at ${buttonPath}`, {
                                        ...context,
                                        modalName: button.modal.substring(0, 30) + '...',
                                    });
                                    button.modal = null;
                                }
                                else {
                                    throw new Error(`Modal not found: ${button.modal}`);
                                }
                            }
                            catch (error) {
                                logger_1.logger.error(`Error processing modal for button at ${buttonPath}`, {
                                    ...context,
                                    modalName: button.modal.substring(0, 30) + '...',
                                    error: error.message,
                                });
                                if (this.context.options.ignoreMissingRelations) {
                                    button.modal = null;
                                }
                                else {
                                    throw error;
                                }
                            }
                        }
                        else {
                            logger_1.logger.debug(`Button at ${buttonPath} has non-string modal, skipping`, {
                                ...context,
                                modalType: typeof button.modal,
                                buttonPath: buttonPath,
                            });
                        }
                    }
                }
            }
            // Обрабатываем модальные окна в обычных объектах кнопок (без __component)
            if (obj &&
                typeof obj === 'object' &&
                obj.modal &&
                typeof obj.modal === 'string' &&
                !obj.__component) {
                logger_1.logger.debug(`🎯 Processing modal in generic button object at ${path}`, {
                    ...context,
                    modalName: obj.modal.substring(0, 50) + '...',
                    buttonText: obj.text || 'No text',
                    buttonPath: path,
                });
                try {
                    logger_1.logger.debug(`🔍 Searching for modal in generic button object`, {
                        ...context,
                        modalName: obj.modal,
                        searchField: 'title',
                        locale,
                        createMissingEntities: this.context.options.createMissingEntities,
                    });
                    // Ищем модальное окно по title
                    const modalId = await this.findEntityByName('api::modal.modal', obj.modal, 'title', locale, this.context.options.ignoreMissingRelations, 'Modal');
                    if (modalId) {
                        logger_1.logger.debug(`✅ Found existing modal for generic button object at ${path}`, {
                            ...context,
                            modalId,
                            modalName: obj.modal.substring(0, 30) + '...',
                        });
                        obj.modal = modalId;
                    }
                    else if (this.context.options.createMissingEntities) {
                        // Создаем новое модальное окно
                        try {
                            logger_1.logger.info(`🚀 Creating missing modal for generic button object at ${path}`, {
                                ...context,
                                modalName: obj.modal.substring(0, 30) + '...',
                            });
                            const createdModalId = await this.createMissingRelationEntity('api::modal.modal', obj.modal, locale);
                            if (createdModalId) {
                                logger_1.logger.info(`✅ Created modal for generic button object at ${path}`, {
                                    ...context,
                                    createdModalId,
                                    modalName: obj.modal.substring(0, 30) + '...',
                                });
                                obj.modal = createdModalId;
                            }
                            else {
                                throw new Error(`Failed to create modal: ${obj.modal}`);
                            }
                        }
                        catch (createError) {
                            logger_1.logger.error(`Failed to create modal for generic button object at ${path}`, {
                                ...context,
                                modalName: obj.modal.substring(0, 30) + '...',
                                createError: createError.message,
                            });
                            if (this.context.options.ignoreMissingRelations) {
                                obj.modal = null;
                            }
                            else {
                                throw createError;
                            }
                        }
                    }
                    else if (this.context.options.ignoreMissingRelations) {
                        logger_1.logger.warn(`Ignoring missing modal for generic button object at ${path}`, {
                            ...context,
                            modalName: obj.modal.substring(0, 30) + '...',
                        });
                        obj.modal = null;
                    }
                    else {
                        // Last resort: Force creation if this looks like a modal name
                        if (obj.modal.length > 10 && (obj.modal.includes(' ') || /[а-яё]/i.test(obj.modal))) {
                            logger_1.logger.warn(`🔥 Force creating modal as last resort for: "${obj.modal.substring(0, 30)}..."`, {
                                ...context,
                                modalName: obj.modal.substring(0, 30) + '...',
                                hint: 'This should normally be handled by createMissingEntities option',
                            });
                            try {
                                const createdModalId = await this.createMissingRelationEntity('api::modal.modal', obj.modal, locale);
                                if (createdModalId) {
                                    obj.modal = createdModalId;
                                }
                                else {
                                    obj.modal = null;
                                }
                            }
                            catch (forceCreateError) {
                                logger_1.logger.error(`Failed to force create modal`, {
                                    ...context,
                                    error: forceCreateError.message,
                                });
                                obj.modal = null;
                            }
                        }
                        else {
                            throw new Error(`Modal not found: ${obj.modal}`);
                        }
                    }
                }
                catch (error) {
                    logger_1.logger.error(`Error processing modal for generic button object at ${path}`, {
                        ...context,
                        modalName: obj.modal.substring(0, 30) + '...',
                        error: error.message,
                    });
                    if (this.context.options.ignoreMissingRelations) {
                        obj.modal = null;
                    }
                    else {
                        throw error;
                    }
                }
            }
            // Рекурсивно обрабатываем все вложенные объекты и массивы
            for (const [key, value] of Object.entries(obj)) {
                if (key !== 'buttons' && typeof value === 'object' && value !== null) {
                    const newPath = path ? `${path}.${key}` : key;
                    // Проверяем, является ли это поле button компонентом (может быть одиночным или массивом)
                    if ((key === 'button' ||
                        key === 'desktopButtons' ||
                        key === 'mobileButtons' ||
                        key === 'desktopButton' ||
                        key === 'mobileButton' ||
                        key === 'responsiveButtons' ||
                        key === 'bannerButtons') &&
                        value) {
                        if (Array.isArray(value)) {
                            // Массив button компонентов
                            logger_1.logger.debug(`🔍 Found button array at ${newPath}`, {
                                ...context,
                                buttonsCount: value.length,
                                buttonPath: newPath,
                            });
                            for (let buttonIndex = 0; buttonIndex < value.length; buttonIndex++) {
                                const buttonComponent = value[buttonIndex];
                                const buttonPath = `${newPath}[${buttonIndex}]`;
                                logger_1.logger.debug(`🎯 Processing button array item ${buttonIndex + 1}/${value.length}`, {
                                    ...context,
                                    buttonIndex,
                                    buttonText: (buttonComponent === null || buttonComponent === void 0 ? void 0 : buttonComponent.text) || 'No text',
                                    hasModal: !!(buttonComponent === null || buttonComponent === void 0 ? void 0 : buttonComponent.modal),
                                    modalValue: buttonComponent === null || buttonComponent === void 0 ? void 0 : buttonComponent.modal,
                                    buttonComponent: (buttonComponent === null || buttonComponent === void 0 ? void 0 : buttonComponent.__component) || 'no component',
                                    buttonPath,
                                });
                                await processButtonsRecursively(buttonComponent, buttonPath);
                            }
                        }
                        else {
                            // Одиночный button компонент
                            logger_1.logger.debug(`🔍 Found single button at ${newPath}`, {
                                ...context,
                                hasModal: !!value.modal,
                                buttonPath: newPath,
                            });
                            await processButtonsRecursively(value, newPath);
                        }
                    }
                    else {
                        // Обычная рекурсивная обработка
                        await processButtonsRecursively(value, newPath);
                    }
                }
            }
        };
        try {
            await processButtonsRecursively(item, 'item');
        }
        catch (error) {
            logger_1.logger.error(`Error in processButtonsWithModals`, {
                ...context,
                error: error.message,
            });
            if (!this.context.options.ignoreMissingRelations) {
                throw error;
            }
        }
    }
    async findEntityByName(contentType, name, nameField = 'name', locale = null, ignoreMissingRelations = false, entityType = 'Entity') {
        var _a, _b, _c, _d, _e, _f;
        const context = {
            operation: 'findEntityByName',
            contentType,
            name: name.substring(0, 50) + '...',
            nameField,
            locale,
        };
        logger_1.logger.debug(`🔍 STARTING search for ${entityType} by ${nameField}`, context);
        // Убедимся, что name - строка и не пустая
        if (typeof name !== 'string' || !name.trim()) {
            logger_1.logger.warn(`❌ Invalid name value for ${entityType} lookup: ${name}`, context);
            if (ignoreMissingRelations) {
                return null;
            }
            else {
                throw new Error(`Invalid ${entityType} name: ${name}`);
            }
        }
        // Normalize the name by trimming whitespace
        const normalizedName = name.trim();
        logger_1.logger.debug(`📝 Normalized search name: original="${name.substring(0, 30)}..." -> normalized="${normalizedName.substring(0, 30)}..."`, context);
        try {
            let entity = null;
            // Strategy 1: Check if model has i18n/localization
            const targetModel = (0, models_1.getModel)(contentType);
            const isLocalized = ((_a = targetModel === null || targetModel === void 0 ? void 0 : targetModel.pluginOptions) === null || _a === void 0 ? void 0 : _a.i18n) &&
                ((_b = targetModel.pluginOptions.i18n) === null || _b === void 0 ? void 0 : _b.localized) === true;
            logger_1.logger.debug(`🌐 Content type localization info`, {
                ...context,
                isLocalized,
                hasI18nPlugin: !!((_c = targetModel === null || targetModel === void 0 ? void 0 : targetModel.pluginOptions) === null || _c === void 0 ? void 0 : _c.i18n),
                draftAndPublish: (_d = targetModel === null || targetModel === void 0 ? void 0 : targetModel.options) === null || _d === void 0 ? void 0 : _d.draftAndPublish,
            });
            // Strategy 2: Enhanced search with proper locale handling
            const searchLocales = isLocalized
                ? ['ru', 'en', 'kk', 'default', locale].filter(Boolean)
                : [null]; // Non-localized content
            for (const searchLocale of searchLocales) {
                try {
                    // Build search criteria
                    const searchWhere = {
                        [nameField]: normalizedName,
                    };
                    // Only add locale filter for localized content
                    if (isLocalized && searchLocale && searchLocale !== 'default') {
                        searchWhere.locale = searchLocale;
                    }
                    else if (isLocalized && searchLocale === 'default') {
                        // For 'default' locale, try both null and 'en' as fallback
                        searchWhere.locale = ['en', null];
                    }
                    logger_1.logger.debug(`🎯 Searching with criteria`, {
                        ...context,
                        searchLocale,
                        searchWhere: JSON.stringify(searchWhere),
                    });
                    entity = await strapi.db.query(contentType).findOne({
                        where: searchWhere,
                    });
                    if (entity) {
                        logger_1.logger.debug(`✅ Found entity with locale ${searchLocale}`, {
                            ...context,
                            entityId: entity.id,
                            documentId: entity.documentId,
                            foundLocale: entity.locale || 'null',
                            foundValue: entity[nameField],
                        });
                        return entity.documentId || entity.id;
                    }
                }
                catch (error) {
                    logger_1.logger.debug(`Error searching with locale ${searchLocale}: ${error.message}`, context);
                }
            }
            // Strategy 3: Case-insensitive search across all locales
            try {
                const fuzzyWhere = {
                    [nameField]: {
                        $containsi: normalizedName,
                    },
                };
                logger_1.logger.debug(`🔍 Fuzzy search with case-insensitive matching`, {
                    ...context,
                    fuzzyWhere: JSON.stringify(fuzzyWhere),
                });
                entity = await strapi.db.query(contentType).findOne({
                    where: fuzzyWhere,
                });
                if (entity) {
                    logger_1.logger.debug(`✅ Found by fuzzy search (case-insensitive)`, {
                        ...context,
                        entityId: entity.id,
                        documentId: entity.documentId,
                        foundValue: entity[nameField],
                        foundLocale: entity.locale || 'null',
                    });
                    return entity.documentId || entity.id;
                }
            }
            catch (error) {
                logger_1.logger.debug(`Error in fuzzy search: ${error.message}`, context);
            }
            // Strategy 4: Special handling for countries with name variations
            if (contentType === 'api::country.country') {
                const countryNameVariations = this.getCountryNameVariations(normalizedName);
                logger_1.logger.debug(`🌍 Trying country name variations`, {
                    ...context,
                    originalName: normalizedName,
                    variations: countryNameVariations,
                });
                for (const variation of countryNameVariations) {
                    try {
                        for (const searchLocale of searchLocales) {
                            const variationWhere = {
                                [nameField]: variation,
                            };
                            if (isLocalized && searchLocale && searchLocale !== 'default') {
                                variationWhere.locale = searchLocale;
                            }
                            entity = await strapi.db.query(contentType).findOne({
                                where: variationWhere,
                            });
                            if (entity) {
                                logger_1.logger.debug(`✅ Found country by name variation`, {
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
                    }
                    catch (error) {
                        logger_1.logger.debug(`Error searching country variation ${variation}: ${error.message}`, context);
                    }
                }
            }
            // Strategy 5: Debug - List available entities to understand what's in the database
            try {
                logger_1.logger.debug(`🔍 Listing available entities for debugging`, context);
                const availableEntities = await strapi.db.query(contentType).findMany({
                    limit: 10,
                    select: [nameField, 'locale', 'id', 'documentId'],
                });
                logger_1.logger.debug(`📋 Available entities sample (first 10):`, {
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
            catch (debugError) {
                logger_1.logger.debug(`Error listing entities for debug: ${debugError.message}`, context);
            }
            // Strategy 6: For templates, also try searching by slug
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
                        logger_1.logger.debug(`✅ Found template by generated slug`, {
                            ...context,
                            entityId: entity.id,
                            generatedSlug: slug,
                        });
                        return entity.documentId || entity.id;
                    }
                }
                catch (error) {
                    logger_1.logger.debug(`Error searching template by slug: ${error.message}`, context);
                }
            }
            // Entity not found - prepare detailed error information
            const searchDetails = {
                searchedName: normalizedName,
                searchField: nameField,
                contentType: contentType,
                isLocalized: isLocalized,
                searchedLocales: isLocalized ? searchLocales.filter((l) => l !== null) : ['non-localized'],
                triedVariations: contentType === 'api::country.country'
                    ? this.getCountryNameVariations(normalizedName)
                    : [normalizedName],
                hasI18nPlugin: !!((_e = targetModel === null || targetModel === void 0 ? void 0 : targetModel.pluginOptions) === null || _e === void 0 ? void 0 : _e.i18n),
                draftAndPublish: (_f = targetModel === null || targetModel === void 0 ? void 0 : targetModel.options) === null || _f === void 0 ? void 0 : _f.draftAndPublish,
            };
            logger_1.logger.warn(`❌ Related entity with ${nameField}='${normalizedName.substring(0, 30)}...' not found in ${contentType} (checked both published and draft)`, { ...context, searchDetails });
            if (ignoreMissingRelations) {
                logger_1.logger.debug(`⚠️ Ignoring missing ${entityType} because ignoreMissingRelations=true`, context);
                return null;
            }
            else {
                logger_1.logger.error(`🚫 Throwing error for missing ${entityType} because ignoreMissingRelations=false`, context);
                // Create enhanced error with detailed information
                const enhancedError = new Error(`Related entity with ${nameField}='${normalizedName.substring(0, 50)}${normalizedName.length > 50 ? '...' : ''}' not found in ${contentType} (checked both published and draft)`);
                // Add search details to error for better debugging
                enhancedError.searchDetails = searchDetails;
                throw enhancedError;
            }
        }
        catch (error) {
            logger_1.logger.error(`Error finding ${entityType} by name`, {
                ...context,
                error: error.message,
            });
            if (ignoreMissingRelations || error.message.includes('not found in')) {
                return null;
            }
            else {
                throw error;
            }
        }
    }
    /**
     * Get country name variations for better matching
     */
    getCountryNameVariations(countryName) {
        const variations = [countryName];
        // Common country name mappings
        const countryMappings = {
            China: ['Китай', 'China', "People's Republic of China"],
            Китай: ['China', 'Китай', "People's Republic of China"],
            Russia: ['Россия', 'Russian Federation', 'Russia'],
            'Russian Federation': ['Россия', 'Russia', 'Russian Federation'],
            Россия: ['Russia', 'Russian Federation', 'Россия'],
            USA: ['United States', 'United States of America', 'США', 'USA'],
            'United States': ['USA', 'United States of America', 'США', 'United States'],
            'United States of America': ['USA', 'United States', 'США', 'United States of America'],
            США: ['USA', 'United States', 'United States of America', 'США'],
            Germany: ['Германия', 'Germany', 'Deutschland'],
            Германия: ['Germany', 'Германия', 'Deutschland'],
            Kazakhstan: ['Казахстан', 'Kazakhstan'],
            Казахстан: ['Kazakhstan', 'Казахстан'],
            'United Kingdom': ['UK', 'Great Britain', 'Britain', 'Великобритания', 'United Kingdom'],
            UK: ['United Kingdom', 'Great Britain', 'Britain', 'Великобритания', 'UK'],
            'North Korea': ['DPRK', "Democratic People's Republic of Korea", 'Северная Корея'],
            'South Korea': ['Korea', 'Republic of Korea', 'Южная Корея'],
            'Iran, Islamic Republic of': ['Iran', 'Иран'],
            Iran: ['Iran, Islamic Republic of', 'Иран'],
            "Lao People's Democratic Republic": ['Laos', 'Лаос'],
            'Palestinian Territory, Occupied': ['Palestine', 'Палестина'],
        };
        // Add variations from mapping
        const mappedVariations = countryMappings[countryName];
        if (mappedVariations) {
            variations.push(...mappedVariations);
        }
        // Remove duplicates and return
        return [...new Set(variations)];
    }
    detectDuplicatesInImportData(importData) {
        for (const [contentType, entries] of Object.entries(importData)) {
            const context = {
                operation: 'duplicate-detection',
                contentType,
                totalEntries: entries.length,
            };
            if (entries.length <= 1)
                continue;
            logger_1.logger.debug(`🔍 Checking for duplicates in ${contentType}`, context);
            const model = (0, models_1.getModel)(contentType);
            if (!model)
                continue;
            // Determine which field to use for duplicate detection
            const duplicateCheckFields = ['title', 'name', 'slug', 'id'];
            const availableFields = duplicateCheckFields.filter((field) => model.attributes[field]);
            if (availableFields.length === 0)
                continue;
            const primaryField = availableFields[0];
            const seen = new Map(); // value -> entry indices
            entries.forEach((entry, index) => {
                // Check both published and draft versions
                const versions = [];
                if (entry.published)
                    versions.push(...Object.values(entry.published));
                if (entry.draft)
                    versions.push(...Object.values(entry.draft));
                versions.forEach((versionData) => {
                    const fieldValue = versionData[primaryField];
                    if (fieldValue && typeof fieldValue === 'string') {
                        const normalizedValue = fieldValue.trim();
                        if (!seen.has(normalizedValue)) {
                            seen.set(normalizedValue, []);
                        }
                        seen.get(normalizedValue).push(index);
                    }
                });
            });
            // Report duplicates
            let duplicateCount = 0;
            for (const [value, indices] of seen.entries()) {
                if (indices.length > 1) {
                    duplicateCount++;
                    logger_1.logger.warn(`🔄 Duplicate entries found in ${contentType}`, {
                        ...context,
                        field: primaryField,
                        value,
                        entryIndices: indices,
                        duplicateCount: indices.length,
                    });
                }
            }
            if (duplicateCount > 0) {
                logger_1.logger.warn(`⚠️ Found ${duplicateCount} duplicate value(s) in ${contentType}`, {
                    ...context,
                    duplicateCount,
                    field: primaryField,
                });
            }
            else {
                logger_1.logger.debug(`✅ No duplicates found in ${contentType}`, context);
            }
        }
    }
    generateUniqueKey(contentType, data) {
        const key = `${contentType}-${data.title || data.name || data.slug || data.id}`;
        return key;
    }
    /**
     * Build detailed path for error tracking
     */
    buildDetailedPath(contentType, status, locale, additionalPath = '') {
        const basePath = `${contentType}.${status}.${locale}`;
        return additionalPath ? `${basePath}.${additionalPath}` : basePath;
    }
    /**
     * Add enhanced failure with detailed path information
     */
    addEnhancedFailure(error, entry, contentType, status, locale, fieldPath = '', additionalDetails = {}) {
        const fullPath = this.buildDetailedPath(contentType, status, locale, fieldPath);
        const enhancedDetails = {
            ...additionalDetails,
            contentType,
            status,
            locale,
            fieldPath,
            searchDetails: error.searchDetails,
            timestamp: new Date().toISOString(),
        };
        this.context.addFailure(error.message, {
            entry,
            path: fullPath,
        }, enhancedDetails);
    }
    async createMissingRelationEntity(contentType, name, locale) {
        var _a;
        const context = {
            operation: 'createMissingRelationEntity',
            contentType,
            name: name.substring(0, 50) + '...',
            locale,
        };
        logger_1.logger.info(`🚀 Creating missing relation entity`, context);
        const entityLocale = locale || 'ru';
        let entityData = {};
        try {
            // Get the target model to understand its structure
            const targetModel = (0, models_1.getModel)(contentType);
            if (!targetModel) {
                logger_1.logger.error(`❌ Model not found for content type: ${contentType}`, context);
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
            if (((_a = targetModel.options) === null || _a === void 0 ? void 0 : _a.draftAndPublish) !== false) {
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
                        }
                        catch (error) {
                            logger_1.logger.debug(`Error checking code uniqueness: ${error.message}`, context);
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
                    logger_1.logger.info(`🔧 Using generic entity creation for ${contentType}`, context);
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
            logger_1.logger.debug(`📋 Creating entity with data:`, {
                ...context,
                entityData: JSON.stringify(entityData, null, 2),
            });
            const newEntity = await strapi.db.query(contentType).create({
                data: entityData,
            });
            if (newEntity) {
                logger_1.logger.info(`✅ Successfully created missing ${contentType}`, {
                    ...context,
                    entityId: newEntity.id,
                    documentId: newEntity.documentId || newEntity.id,
                    mainField,
                    mainValue: entityData[mainField],
                });
                // Cache the created entity
                const cacheKey = `${contentType}:${name}`;
                this.createdEntitiesCache.set(cacheKey, newEntity.id);
                return newEntity.id;
            }
            else {
                logger_1.logger.error(`❌ Failed to create entity - received null response`, context);
                return null;
            }
        }
        catch (error) {
            logger_1.logger.error(`❌ Error creating missing relation entity`, {
                ...context,
                error: error.message,
                errorDetails: error.details || 'No details available',
                errorStack: error.stack,
            });
            return null;
        }
    }
    async findInDatabase(idValue, targetModel, targetIdField) {
        const context = {
            operation: 'import',
            contentType: targetModel.uid,
            idField: targetIdField,
            idValue,
        };
        logger_1.logger.debug('Looking up record in database', context);
        // Check both published and draft versions
        const publishedVersion = await this.services
            .documents(targetModel.uid)
            .findFirst({
            filters: { [targetIdField]: idValue },
            status: 'published',
        });
        const draftVersion = await this.services
            .documents(targetModel.uid)
            .findFirst({
            filters: { [targetIdField]: idValue },
            status: 'draft',
        });
        if (publishedVersion && draftVersion) {
            if (publishedVersion.documentId === draftVersion.documentId) {
                logger_1.logger.debug('Found matching published and draft versions', {
                    ...context,
                    documentId: publishedVersion.documentId,
                });
                return publishedVersion;
            }
            logger_1.logger.warn('Found conflicting published and draft versions', {
                ...context,
                publishedId: publishedVersion.documentId,
                draftId: draftVersion.documentId,
            });
            return publishedVersion;
        }
        if (publishedVersion || draftVersion) {
            logger_1.logger.debug('Found single version', {
                ...context,
                status: publishedVersion ? 'published' : 'draft',
                documentId: (publishedVersion || draftVersion).documentId,
            });
        }
        else {
            logger_1.logger.debug('Record not found in database', context);
        }
        return publishedVersion || draftVersion;
    }
}
exports.ImportProcessor = ImportProcessor;
