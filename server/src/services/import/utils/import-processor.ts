import { Schema, UID } from '@strapi/types';
import { ImportContext } from './import-context';
import { EntryVersion, ImportResult, LocaleVersions, ExistingAction } from '../import-v3';
import { getModel, isComponentAttribute, isDynamicZoneAttribute, isMediaAttribute, isRelationAttribute } from '../../../utils/models';
import { getIdentifierField } from '../../../utils/identifiers';
import { findOrImportFile } from '../utils/file';
import { logger } from '../../../utils/logger';

export class ImportProcessor {
    constructor(
        private context: ImportContext,
        private services: {
            documents: typeof strapi.documents;
        }
    ) {}

    async process(): Promise<ImportResult> {
        for (const [contentType, entries] of Object.entries(this.context.importData) as [UID.ContentType, EntryVersion[]][]) {
            const context = {
                operation: 'import',
                contentType
            };

            const model = getModel(contentType);
            if (!model) {
                logger.error(`Model not found`, context);
                this.context.addFailure(`Model ${contentType} not found`, contentType);
                continue;
            }

            const idField = getIdentifierField(model);
            logger.debug(`Processing entries with identifier field: ${idField}`, context);

            // Import each entry's versions
            for (const entry of entries) {
                try {
                    await this.processEntry(contentType, entry, model, idField);
                } catch (error) {
                    logger.error(`Failed to import entry`, context, error);
                    if (error.details) {
                        logger.debug("Error Details", { ...context, details: error.details });
                    }
                    this.context.addFailure(error.message || 'Unknown error', entry);
                }
            }
        }

        return { failures: this.context.getFailures() };
    }

    private async processEntry(
        contentType: UID.ContentType,
        entry: EntryVersion,
        model: Schema.Schema,
        idField: string
    ): Promise<string | null> {
        const context = {
            operation: 'import',
            contentType,
            idField
        };

        let documentId: string | null = null;

        // First handle published versions if they exist
        if (entry.published) {
            logger.debug("Processing published version", context);
            documentId = await this.importVersionData(contentType, entry.published, model, {
                status: 'published',
                idField
            });
        }

        // Then handle draft versions if they exist
        if (entry.draft) {
            logger.debug("Processing draft version", context);
            documentId = await this.importVersionData(contentType, entry.draft, model, {
                documentId,
                status: 'draft',
                idField
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
            idField: string;
        }
    ): Promise<string | null> {
        const context = {
            operation: 'import',
            contentType,
            status: options.status,
            documentId: options.documentId
        };

        logger.debug('Processing version data', context);

        let { documentId } = options;
        let processedFirstLocale = false;

        // Determine which locale to process first
        const locales = Object.keys(versionData);
        const firstLocale = locales.includes('default') ? 'default' : locales[0];
        const firstData = versionData[firstLocale];

        if (!documentId) {
            // Look for existing entry
            const existing = await this.services.documents(contentType).findFirst({
                filters: { [options.idField]: firstData[options.idField] },
                status: options.status
            });

            if (existing) {
                logger.debug('Found existing entry', { ...context, idValue: firstData[options.idField] });
            }

            const processedData = await this.processEntryData(firstData, model);
            const sanitizedData = this.sanitizeData(processedData, model);

            if (existing) {
                switch (this.context.options.existingAction) {
                    case ExistingAction.Skip:
                        if (!this.context.wasDocumentCreatedInThisImport(existing.documentId)) {
                            logger.info(`Skipping existing entry`, { 
                                ...context, 
                                idField: options.idField, 
                                idValue: firstData[options.idField] 
                            });
                            return existing.documentId;
                        }
                        logger.debug('Entry was created in this import, proceeding with update', context);
                        // fall through to update
                        
                    case ExistingAction.Update:
                        if (options.status === 'draft' && !this.context.options.allowDraftOnPublished) {
                            const existingPublished = await this.services.documents(contentType).findOne({
                                documentId: existing.documentId,
                                status: 'published'
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

                        logger.debug('Updating existing entry', { ...context, documentId: existing.documentId });
                        await this.services.documents(contentType).update({
                            documentId: existing.documentId,
                            locale: firstLocale === 'default' ? undefined : firstLocale,
                            data: sanitizedData,
                            status: options.status
                        });
                        documentId = existing.documentId;
                        this.context.recordUpdated(contentType, firstData[options.idField], existing.documentId);
                        processedFirstLocale = true;
                        break;

                    case ExistingAction.Warn:
                    default:
                        logger.warn('Entry already exists', { 
                            ...context, 
                            idField: options.idField, 
                            idValue: firstData[options.idField] 
                        });
                        this.context.addFailure(
                            `Entry with ${options.idField}=${firstData[options.idField]} already exists`,
                            versionData
                        );
                        return null;
                }
            } else {
                logger.debug('Creating new entry', context);
                const created = await this.services.documents(contentType).create({
                    data: sanitizedData,
                    status: options.status,
                    locale: firstLocale === 'default' ? undefined : firstLocale,
                });
                documentId = created.documentId;
                this.context.recordCreated(contentType, firstData[options.idField], created.documentId);
                processedFirstLocale = true;
            }
        }

        // Handle all locales (only skip first if we just processed it)
        for (const locale of locales) {
            const localeContext = {
                ...context,
                locale,
                documentId
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
                            status: 'published'
                        }),
                        this.services.documents(contentType).findOne({
                            documentId,
                            status: 'draft'
                        })
                    ]);

                    // Collect all existing locales
                    [publishedVersion, draftVersion].forEach(version => {
                        if (version) {
                            existingLocales.add(version.locale || 'default');
                            version.localizations?.forEach(loc => 
                                existingLocales.add(loc.locale)
                            );
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
            const processedLocale = await this.processEntryData(localeData, model);
            const sanitizedLocaleData = this.sanitizeData(processedLocale, model);

            await this.services.documents(contentType).update({
                documentId,
                locale: locale === 'default' ? undefined : locale,
                data: sanitizedLocaleData,
                status: options.status
            });
        }

        return documentId;
    }

    private async processEntryData(
        data: any, 
        model: Schema.Schema
    ): Promise<any> {
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
                            const documentIds = await Promise.all(
                                data[key].map(async (value) => {
                                    try {
                                        return await this.processRelation(value, attr);
                                    } catch (error) {
                                        console.error(`Failed to process relation array item`, error);
                                        this.context.addFailure(
                                            `Failed to process relation in ${key}: ${error.message}`,
                                            { value, attribute: key }
                                        );
                                        return null;
                                    }
                                })
                            );
                            processed[key] = documentIds.filter(id => id !== null);
                        } else {
                            try {
                                processed[key] = await this.processRelation(data[key], attr);
                            } catch (error) {
                                console.error(`Failed to process relation`, error);
                                this.context.addFailure(
                                    `Failed to process relation in ${key}: ${error.message}`,
                                    { value: data[key], attribute: key }
                                );
                                processed[key] = null;
                            }
                        }
                    } else if (isComponentAttribute(attr)) {
                        try {
                            processed[key] = await this.processComponent(data[key], attr);
                        } catch (error) {
                            console.error(`Failed to process component`, error);
                            this.context.addFailure(
                                `Failed to process component in ${key}: ${error.message}`,
                                { value: data[key], attribute: key }
                            );
                            processed[key] = null;
                        }
                    } else if (isDynamicZoneAttribute(attr)) {
                        processed[key] = await this.processDynamicZone(
                            data[key]
                        );
                    } else if (isMediaAttribute(attr)) {
                        const allowedTypes = (attr as Schema.Attribute.Media).allowedTypes || ['any'];
                        processed[key] = await this.processMedia(data[key], allowedTypes);
                    }
                } catch (error) {
                    console.error(`Failed to process attribute ${key}`, error);
                    this.context.addFailure(
                        `Failed to process attribute ${key}: ${error.message}`,
                        { value: data[key], attribute: key }
                    );
                    processed[key] = null;
                }
            }
            return processed;
        } catch (error) {
            console.error(`Failed to process entry data`, error);
            this.context.addFailure(
                `Failed to process entry data: ${error.message}`,
                data
            );
            throw error; // Re-throw to be caught by processEntry
        }
    }

    private async processRelation(
        relationValue: any,
        attr: Schema.Attribute.RelationWithTarget
    ): Promise<string | null> {
        const context = {
            operation: 'import',
            contentType: attr.target,
            relation: relationValue
        };

        if (!relationValue) {
            logger.debug('Skipping null relation', context);
            return null;
        }

        try {
            const targetModel = getModel(attr.target);
            if (!targetModel) {
                logger.warn(`Target model not found`, context);
                throw new Error(`Target model ${attr.target} not found`);
            }

            const targetIdField = getIdentifierField(targetModel);
            logger.debug(`Processing relation with identifier field: ${targetIdField}`, context);

            // Check if this relation has already been processed
            const documentId = this.context.findProcessedRecord(attr.target, relationValue);
            if (documentId) {
                logger.debug('Found previously processed relation', { ...context, documentId });
                return documentId;
            }

            // Skip database lookup if disallowNewRelations is true and we're in skip mode
            if (this.context.options.disallowNewRelations && 
                this.context.options.existingAction === ExistingAction.Skip) {
                logger.debug('Skipping database lookup (disallowNewRelations enabled)', context);
                return null;
            }

            // Look for the target in import data first
            if (this.context.importData[attr.target]) {
                logger.debug('Looking for relation in import data', context);
                const targetEntry = this.findEntryInImportData(
                    relationValue,
                    targetIdField,
                    this.context.importData[attr.target]
                );

                if (targetEntry) {
                    // If we found an entry, check if it has both draft and published versions
                    const publishedIdValue = targetEntry.published?.default?.[targetIdField];
                    const draftIdValue = targetEntry.draft?.default?.[targetIdField];

                    if (publishedIdValue && draftIdValue && publishedIdValue !== draftIdValue) {
                        // If disallowNewRelations is true, skip database lookup
                        if (this.context.options.disallowNewRelations && this.context.options.existingAction === ExistingAction.Skip) {
                            console.log(`Skipping database lookup for relation ${attr.target}:${publishedIdValue} (disallowNewRelations is true)`);
                            return null;
                        }
                        // If the values are different, we need to look up the published version in the database
                        const dbRecord = await this.findInDatabase(publishedIdValue, targetModel, targetIdField);
                        if (dbRecord) {
                            logger.debug('Found relation in database', { ...context, documentId: dbRecord.documentId });
                            return dbRecord.documentId;
                        }
                    }

                    // Process the entry if it's a oneWay/manyWay relation
                    if (attr.relation === 'oneWay' || attr.relation === 'manyWay') {
                        console.log(`Processing related entry from import data: ${attr.target} ${relationValue}`);
                        return await this.processEntry(
                            attr.target,
                            targetEntry,
                            targetModel,
                            targetIdField
                        );
                    }
                }
            }

            // If disallowNewRelations is true, skip database lookup
            if (this.context.options.disallowNewRelations && this.context.options.existingAction === ExistingAction.Skip) {
                console.log(`Skipping database lookup for relation ${attr.target}:${relationValue} (disallowNewRelations is true)`);
                return null;
            }

            // If not found in import data or not processable, look in database
            const dbRecord = await this.findInDatabase(relationValue, targetModel, targetIdField);
            if (dbRecord) {
                logger.debug('Found relation in database', { ...context, documentId: dbRecord.documentId });
            } else {
                logger.warn('Relation not found in database', context);
            }
            return dbRecord?.documentId || null;

        } catch (error) {
            logger.error(`Failed to process relation`, context, error);
            this.context.addFailure(
                `Failed to process relation to ${attr.target}: ${error.message}`,
                { value: relationValue, attribute: attr }
            );
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
            idValue
        };

        logger.debug('Looking up record in database', context);

        // Check both published and draft versions
        const publishedVersion = await this.services.documents(targetModel.uid as UID.ContentType).findFirst({
            filters: { [targetIdField]: idValue },
            status: 'published'
        });

        const draftVersion = await this.services.documents(targetModel.uid as UID.ContentType).findFirst({
            filters: { [targetIdField]: idValue },
            status: 'draft'
        });

        if (publishedVersion && draftVersion) {
            if (publishedVersion.documentId === draftVersion.documentId) {
                logger.debug('Found matching published and draft versions', {
                    ...context,
                    documentId: publishedVersion.documentId
                });
                return publishedVersion;
            }
            logger.warn('Found conflicting published and draft versions', {
                ...context,
                publishedId: publishedVersion.documentId,
                draftId: draftVersion.documentId
            });
            return publishedVersion;
        }

        if (publishedVersion || draftVersion) {
            logger.debug('Found single version', {
                ...context,
                status: publishedVersion ? 'published' : 'draft',
                documentId: (publishedVersion || draftVersion).documentId
            });
        } else {
            logger.debug('Record not found in database', context);
        }

        return publishedVersion || draftVersion;
    }

    private async processComponent(
        value: any, 
        attr: Schema.Attribute.Component
    ): Promise<any> {
        if (Array.isArray(value)) {
            return Promise.all(
                value.map(item => 
                    this.processComponentItem(item, attr.component)
                )
            );
        }
        return this.processComponentItem(value, attr.component);
    }

    private async processComponentItem(
        item: any,
        componentType: string
    ): Promise<any> {
        const processed = { ...item };
        const componentModel = getModel(componentType);

        for (const [key, attr] of Object.entries(componentModel.attributes)) {
            if (!item[key]) continue;

            if (isMediaAttribute(attr)) {
                const allowedTypes = (attr as Schema.Attribute.Media).allowedTypes || ['any'];
                processed[key] = await this.processMedia(item[key], allowedTypes);
            } else if (isRelationAttribute(attr)) {
                processed[key] = await this.processRelation(
                    item[key],
                    attr
                );
            }
        }

        return processed;
    }

    private async processDynamicZone(
        items: any[]
    ): Promise<any[]> {
        return Promise.all(
            items.map(async item => ({
                __component: item.__component,
                ...(await this.processComponentItem(
                    item,
                    item.__component
                ))
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
            allowedTypes
        };

        if (Array.isArray(value)) {
            logger.debug('Processing media array', context);
            const media = [];
            for (const item of value) {
                logger.debug('Processing media item', { ...context, url: item });
                const file = await findOrImportFile(item, this.context.user, { allowedFileTypes: allowedTypes });
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
            const file = await findOrImportFile(value, this.context.user, { allowedFileTypes: allowedTypes });
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

    private sanitizeData(data: any, model: Schema.Schema): any {
        const context = {
            operation: 'import',
            contentType: model.uid
        };

        if (!data || typeof data !== 'object') {
            logger.debug('Skipping sanitization for non-object data', context);
            return data;
        }
        
        logger.debug('Sanitizing data', context);
        const sanitized = { ...data };
        const validAttributes = Object.entries(model.attributes)
            .filter(([_, attr]) => attr.configurable !== false);
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
} 