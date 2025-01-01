import { Schema, UID } from '@strapi/types';
import { ImportContext } from './import-context';
import { EntryVersion, ImportResult, LocaleVersions, ExistingAction } from '../import-v3';
import { getModel, isComponentAttribute, isDynamicZoneAttribute, isMediaAttribute, isRelationAttribute } from '../../../utils/models';
import { getIdentifierField } from '../../../utils/identifiers';
import { findOrImportFile } from '../utils/file';

export class ImportProcessor {
    constructor(
        private context: ImportContext,
        private services: {
            documents: typeof strapi.documents;
        }
    ) {}

    async process(): Promise<ImportResult> {
        for (const [contentType, entries] of Object.entries(this.context.importData) as [UID.ContentType, EntryVersion[]][]) {
            const model = getModel(contentType);
            if (!model) {
                this.context.addFailure(`Model ${contentType} not found`, contentType);
                continue;
            }

            const idField = getIdentifierField(model);

            // Import each entry's versions
            for (const entry of entries) {
                try {
                    await this.processEntry(contentType, entry, model, idField);
                } catch (error) {
                    console.error(`Failed to import entry`, error);
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
        let documentId: string | null = null;

        // First handle published versions if they exist
        if (entry.published) {
            documentId = await this.importVersionData(contentType, entry.published, model, {
                status: 'published',
                idField
            });
        }

        // Then handle draft versions if they exist
        if (entry.draft) {
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
        let { documentId } = options;
        let processedFirstLocale = false;

        // Determine which locale to process first
        const locales = Object.keys(versionData);
        const firstLocale = locales.includes('default') ? 'default' : locales[0];
        const firstData = versionData[firstLocale];

        if (!documentId) {
            // Look for existing entry
            const existing = await this.services.documents(contentType).findFirst({
                filters: { [options.idField]: firstData[options.idField] }
            });

            const processedData = await this.processEntryData(firstData, model);

            // Sanitize data just before create/update
            const sanitizedData = this.sanitizeData(processedData, model);

            if (existing) {
                switch (this.context.options.existingAction) {
                    case ExistingAction.Skip:
                        if (!this.context.wasDocumentCreatedInThisImport(existing.documentId)) {
                            console.log(`Skipping existing entry with ${options.idField}=${firstData[options.idField]}`);
                            return existing.documentId;
                        }
                        // If created in this import, fall through to update
                        
                    case ExistingAction.Update:
                        if (options.status === 'draft' && !this.context.options.allowDraftOnPublished) {
                            const existingPublished = await this.services.documents(contentType).findOne({
                                documentId: existing.documentId,
                                status: 'published'
                            });

                            if (existingPublished) {
                                this.context.addFailure(
                                    `Cannot apply draft to existing published entry`,
                                    versionData
                                );
                                return null;
                            }
                        }

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
                        this.context.addFailure(
                            `Entry with ${options.idField}=${firstData[options.idField]} already exists`,
                            versionData
                        );
                        return null;
                }
            } else {
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
            if (processedFirstLocale && locale === firstLocale) continue;

            const localeData = versionData[locale];

            // If we're in skip mode
            if (this.context.options.existingAction === ExistingAction.Skip && documentId) {
                if (!this.context.wasDocumentCreatedInThisImport(documentId)) {
                    if (!this.context.options.allowLocaleUpdates) {
                        console.log(`Skipping update for existing entry with documentId: ${documentId}`);
                        continue;
                    }

                    // If we're allowing locale updates, check if this locale already exists
                    const existingLocales = new Set<string>();

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
                        console.log(`Skipping existing locale ${locale} for documentId: ${documentId}`);
                        continue;
                    }

                    console.log(`Creating new locale ${locale} for existing entry with documentId: ${documentId}`);
                }
            }

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
        if (!relationValue) {
            return null;
        }

        try {
            const targetModel = getModel(attr.target);
            if (!targetModel) {
                throw new Error(`Target model ${attr.target} not found`);
            }

            const targetIdField = getIdentifierField(targetModel);

            // Check if this relation has already been processed
            const documentId = this.context.findProcessedRecord(attr.target, relationValue);
            if (documentId) {
                return documentId;
            }

            // Look for the target in import data first
            if (this.context.importData[attr.target]) {
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
                        if (this.context.options.disallowNewRelations) {
                            console.log(`Skipping database lookup for relation ${attr.target}:${publishedIdValue} (disallowNewRelations is true)`);
                            return null;
                        }
                        // If the values are different, we need to look up the published version in the database
                        const dbRecord = await this.findInDatabase(publishedIdValue, targetModel, targetIdField);
                        if (dbRecord) {
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
            if (this.context.options.disallowNewRelations) {
                console.log(`Skipping database lookup for relation ${attr.target}:${relationValue} (disallowNewRelations is true)`);
                return null;
            }

            // If not found in import data or not processable, look in database
            const dbRecord = await this.findInDatabase(relationValue, targetModel, targetIdField);
            return dbRecord?.documentId || null;
        } catch (error) {
            console.error(`Failed to process relation`, error);
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
                return publishedVersion;
            }
            console.warn(`Found both published and draft versions with different documentIds for ${targetModel.uid} ${idValue}. Using published version.`);
            return publishedVersion;
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
        if (Array.isArray(value)) {
            const media = [];
            for (const item of value) {
                console.log('Processing media URL:', item);
                const file = await findOrImportFile(item, this.context.user, { allowedFileTypes: allowedTypes });
                if (file) media.push(file.id);
            }
            return media;
        } else {
            const file = await findOrImportFile(value, this.context.user, { allowedFileTypes: allowedTypes });
            return file?.id || null;
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
        if (!data || typeof data !== 'object') return data;
        
        const sanitized = { ...data };
        const validAttributes = Object.entries(model.attributes)
            .filter(([_, attr]) => attr.configurable !== false);
        const validAttributeNames = new Set(validAttributes.map(([name]) => name));

        // Remove any fields that aren't in the model
        for (const key of Object.keys(sanitized)) {
            if (!validAttributeNames.has(key)) {
                delete sanitized[key];
            }
        }

        return sanitized;
    }
} 