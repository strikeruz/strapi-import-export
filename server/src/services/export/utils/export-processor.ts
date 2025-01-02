import { Schema, UID } from '@strapi/types';
import { ExportContext } from './export-context';
import { buildPopulateForModel } from '../buildPopulate';
import { getModel, isComponentAttribute, isDynamicZoneAttribute, isMediaAttribute, isRelationAttribute } from '../../../utils/models';
import { validateIdField } from '../validation';
import { getConfig } from '../../../utils/getConfig';
import { getIdentifierField } from '../../../utils/identifiers';
import { logger } from '../../../utils/logger';

interface VersionData {
    draft?: Record<string, any>;
    published?: Record<string, any>;
}

export class ExportProcessor {
    constructor(
        private context: ExportContext,
        private services: {
            documents: typeof strapi.documents;
        }
    ) {}

    async processSchema(currentSlug: string) {
        const context = {
            operation: 'export',
            contentType: currentSlug
        };

        const model = getModel(currentSlug);
        if (!model || model.uid === 'admin::user') {
            logger.debug(`Skipping model`, context);
            return;
        }

        try {
            validateIdField(model);
        } catch (error) {
            logger.error('ID field validation failed', context, error);
            throw error;
        }

        logger.debug('Processing schema', context);
        const populate = buildPopulateForModel(model);
        this.context.exportedData[currentSlug] = [];

        // Get all draft entries first
        const draftEntries = await this.services.documents(currentSlug as UID.ContentType).findMany({
            ...(this.context.options.documentIds ? { documentId: { $in: this.context.options.documentIds } } : {}),
            ...(this.context.options.applySearch ? this.context.options.search : {}),
            status: 'draft',
            populate: {
                ...populate,
                ...(this.context.options.exportAllLocales && { 
                    localizations: {
                        populate: populate
                    }
                })
            }
        });

        logger.debug(`Found ${draftEntries.length} draft entries`, context);

        // Process each draft entry and its corresponding published version
        for (const draftEntry of draftEntries) {
            await this.processEntry(currentSlug, draftEntry, model, populate);
        }
    }

    private async processEntry(
        contentType: string,
        draftEntry: any,
        model: Schema.Schema,
        populate: any
    ) {
        const context = {
            operation: 'export',
            contentType,
            documentId: draftEntry.documentId
        };

        logger.debug('Processing entry', context);

        try {
            const publishedEntry = await this.services.documents(contentType as UID.ContentType).findOne({
                documentId: draftEntry.documentId,
                status: 'published',
                populate: {
                    ...populate,
                    ...(this.context.options.exportAllLocales && { 
                        localizations: {
                            populate: populate
                        }
                    })
                }
            });

            if (publishedEntry) {
                logger.debug('Found corresponding published version', context);
            }

            const versions = this.groupByLocale(draftEntry, publishedEntry, model);
            
            if (versions.draft || versions.published) {
                logger.debug('Adding entry to export data', context);
                this.context.exportedData[contentType].push(versions);
                this.context.recordProcessed(draftEntry.documentId);
            } else {
                logger.debug('Skipping entry - no differences found', context);
            }
        } catch (error) {
            logger.error('Failed to process entry', context, error);
            throw error;
        }
    }

    private groupByLocale(draftEntry: any, publishedEntry: any, model: Schema.Schema): VersionData {
        const result: VersionData = {};
        const processedLocales = new Set<string>();

        // Process draft entry
        if (draftEntry) {
            result.draft = {};
            this.processVersion(draftEntry, result.draft, model, processedLocales);
        }

        // Process published entry
        if (publishedEntry) {
            result.published = {};
            this.processVersion(publishedEntry, result.published, model, processedLocales);
        }

        return result;
    }

    private processVersion(
        entry: any,
        versionData: Record<string, any>,
        model: Schema.Schema,
        processedLocales: Set<string>
    ) {
        const locale = entry.locale || 'default';
        if (!processedLocales.has(locale)) {
            versionData[locale] = this.processDataWithSchema(entry, model);
            processedLocales.add(locale);
        }

        // Process localizations if they exist and exportAllLocales is true
        if (this.context.options.exportAllLocales && entry.localizations) {
            for (const localization of entry.localizations) {
                const localeKey = localization.locale || 'default';
                if (!processedLocales.has(localeKey)) {
                    versionData[localeKey] = this.processDataWithSchema(localization, model);
                    processedLocales.add(localeKey);
                }
            }
        }
    }

    private processDataWithSchema(data: any, schema: Schema.Schema): any {
        if (!data) return null;

        const processed = { ...data };
        
        delete processed.id;
        delete processed.documentId;
        delete processed.createdBy;
        delete processed.updatedBy;
        delete processed.localizations;

        for (const [key, attr] of Object.entries(schema.attributes)) {
            if (!data[key]) continue;

            try {
                if (isRelationAttribute(attr)) {
                    if (Array.isArray(data[key])) {
                        processed[key] = data[key].map(item => 
                            this.processRelation(item, attr.target)
                        );
                    } else {
                        processed[key] = this.processRelation(data[key], attr.target);
                    }
                } else if (isComponentAttribute(attr)) {
                    if (Array.isArray(data[key])) {
                        processed[key] = data[key].map(item => 
                            this.processComponent(item, attr.component)
                        );
                    } else {
                        processed[key] = this.processComponent(data[key], attr.component);
                    }
                } else if (isDynamicZoneAttribute(attr)) {
                    processed[key] = this.processDynamicZone(data[key]);
                } else if (isMediaAttribute(attr)) {
                    if (Array.isArray(data[key])) {
                        processed[key] = data[key].map(item => this.processMedia(item));
                    } else {
                        processed[key] = this.processMedia(data[key]);
                    }
                }
            } catch (error) {
                logger.error(`Failed to process attribute`, {
                    operation: 'export',
                    attribute: key,
                    contentType: schema.uid
                }, error);
                processed[key] = null;
            }
        }

        return processed;
    }

    private processRelation(item: any, targetModelUid: string): any {
        const context = {
            operation: 'export',
            contentType: targetModelUid,
            documentId: item?.documentId
        };

        if (!item) {
            logger.debug('Skipping null relation', context);
            return null;
        }

        const targetModel = getModel(targetModelUid);
        if (!targetModel) {
            logger.warn('Target model not found', context);
            return null;
        }

        const idField = getIdentifierField(targetModel);
        const relationValue = item[idField];

        if (this.context.options.skipRelations) {
            logger.debug('Skipping relation processing (skipRelations enabled)', context);
            return relationValue;
        }

        if (!this.context.wasProcessed(item.documentId)) {
            logger.debug('Adding relation for later processing', {
                ...context,
                relationValue
            });
            this.context.addRelation(targetModelUid as UID.ContentType, item.documentId);
        }

        return relationValue;
    }

    private processComponent(item: any, componentUid: string): any {
        const context = {
            operation: 'export',
            componentType: componentUid
        };

        if (!item) {
            logger.debug('Skipping null component', context);
            return null;
        }

        const componentModel = getModel(componentUid);
        if (!componentModel) {
            logger.warn('Component model not found', context);
            return null;
        }

        return this.processDataWithSchema(item, componentModel);
    }

    private processDynamicZone(items: any[]): any[] {
        if (!Array.isArray(items)) {
            logger.warn('Dynamic zone value is not an array', {
                operation: 'export',
                value: items
            });
            return [];
        }

        return items.map(item => {
            const context = {
                operation: 'export',
                componentType: item?.__component
            };

            const componentModel = getModel(item.__component);
            if (!componentModel) {
                logger.warn('Component model not found', context);
                return null;
            }

            logger.debug('Processing dynamic zone component', context);
            return {
                __component: item.__component,
                ...this.processDataWithSchema(item, componentModel)
            };
        }).filter(Boolean);
    }

    private processMedia(item: any): any {
        const context = {
            operation: 'export',
            mediaType: item?.mime
        };

        if (!item) {
            logger.debug('Skipping null media', context);
            return null;
        }

        const { url, ...rest } = item;
        if (!url) {
            logger.warn('Media item missing URL', context);
            return null;
        }

        // Convert relative URLs to absolute
        const absoluteUrl = url.startsWith('http') ? url : this.computeUrl(url);
        logger.debug('Processed media URL', { 
            ...context,
            originalUrl: url,
            absoluteUrl
        });
        return absoluteUrl;
    }

    private computeUrl(relativeUrl: string): string {
        return getConfig('serverPublicHostname') + relativeUrl;
    }

    private areVersionsEqual(version1: any, version2: any, excludeFields = ['publishedAt']): boolean {
        const v1 = { ...version1 };
        const v2 = { ...version2 };
        
        excludeFields.forEach(field => {
            delete v1[field];
            delete v2[field];
        });
        
        return JSON.stringify(v1) === JSON.stringify(v2);
    }
} 