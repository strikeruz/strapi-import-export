"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExportProcessor = void 0;
const buildPopulate_1 = require("../buildPopulate");
const models_1 = require("../../../utils/models");
const validation_1 = require("../validation");
const getConfig_1 = require("../../../utils/getConfig");
const identifiers_1 = require("../../../utils/identifiers");
const logger_1 = require("../../../utils/logger");
class ExportProcessor {
    constructor(context, services) {
        this.context = context;
        this.services = services;
    }
    async processSchema(currentSlug) {
        var _a;
        const context = {
            operation: 'export',
            contentType: currentSlug,
        };
        const model = (0, models_1.getModel)(currentSlug);
        if (!model || model.uid === 'admin::user') {
            logger_1.logger.debug(`Skipping model`, context);
            return;
        }
        try {
            if (model.kind !== 'singleType') {
                (0, validation_1.validateIdField)(model);
            }
        }
        catch (error) {
            logger_1.logger.error('ID field validation failed', context, error);
            throw error;
        }
        logger_1.logger.debug('Processing schema', context);
        const populate = (0, buildPopulate_1.buildPopulateForModel)(currentSlug);
        if (!this.context.exportedData[currentSlug]) {
            this.context.exportedData[currentSlug] = [];
        }
        // Build filters object correctly
        const documentIdFilter = ((_a = this.context.options.documentIds) === null || _a === void 0 ? void 0 : _a.length)
            ? {
                documentId: { $in: this.context.options.documentIds },
            }
            : {};
        const searchParams = this.context.options.applySearch && this.context.options.search
            ? typeof this.context.options.search === 'string'
                ? JSON.parse(this.context.options.search)
                : this.context.options.search
            : {};
        const filtersAndDocs = {
            filters: {
                ...searchParams.filters,
                ...documentIdFilter,
            },
            ...(this.context.options.applySearch && searchParams.sort && { sort: searchParams.sort }),
        };
        console.log('FILTERS AND DOCS', JSON.stringify(filtersAndDocs, null, 2));
        // Get all draft entries first
        const draftEntries = await this.services.documents(currentSlug).findMany({
            ...filtersAndDocs,
            status: 'draft',
            populate: {
                ...populate,
                ...(this.context.options.exportAllLocales && {
                    localizations: {
                        populate,
                    },
                }),
            },
        });
        console.log('DRAFT ENTRIES', JSON.stringify(draftEntries, null, 2));
        logger_1.logger.debug(`Found ${draftEntries.length} draft entries`, context);
        // Process each draft entry and its corresponding published version
        for (const draftEntry of draftEntries) {
            await this.processEntry(currentSlug, draftEntry, model, populate);
        }
    }
    async processEntry(contentType, draftEntry, model, populate) {
        const context = {
            operation: 'export',
            contentType,
            documentId: draftEntry.documentId,
        };
        try {
            const publishedEntry = await this.services.documents(contentType).findOne({
                documentId: draftEntry.documentId,
                status: 'published',
                populate: {
                    ...populate,
                    ...(this.context.options.exportAllLocales && {
                        localizations: {
                            populate,
                        },
                    }),
                },
            });
            const versions = this.groupByLocale(draftEntry, publishedEntry, model);
            // Only add if there are actual differences
            if (versions.draft || versions.published) {
                this.context.exportedData[contentType].push(versions);
                this.context.recordProcessed(draftEntry.documentId);
            }
        }
        catch (error) {
            logger_1.logger.error('Failed to process entry', context, error);
            throw error;
        }
    }
    groupByLocale(entry, publishedEntry, model) {
        var _a, _b, _c;
        const result = {};
        // Always remove localizations from the processed data
        const processEntry = (data) => {
            const processed = this.processDataWithSchema(data, model, {
                processLocalizations: true,
            });
            delete processed.localizations;
            return processed;
        };
        // Compare draft and published versions for each locale
        const draftData = processEntry(entry);
        const publishedData = publishedEntry ? processEntry(publishedEntry) : null;
        // Only include draft if it's different from published
        if (!publishedData || !this.areVersionsEqual(draftData, publishedData)) {
            result.draft = { default: draftData };
        }
        // Process localizations if exporting all locales
        if (this.context.options.exportAllLocales && ((_a = entry.localizations) === null || _a === void 0 ? void 0 : _a.length)) {
            for (const draftLoc of entry.localizations) {
                const locale = draftLoc.locale;
                if (!locale)
                    continue;
                // Find corresponding published localization
                const publishedLoc = (_b = publishedEntry === null || publishedEntry === void 0 ? void 0 : publishedEntry.localizations) === null || _b === void 0 ? void 0 : _b.find((l) => l.locale === locale);
                const draftLocData = processEntry(draftLoc);
                const publishedLocData = publishedLoc ? processEntry(publishedLoc) : null;
                // Only include draft if it's different from published
                if (!publishedLocData || !this.areVersionsEqual(draftLocData, publishedLocData)) {
                    if (!result.draft)
                        result.draft = {};
                    result.draft[locale] = draftLocData;
                }
            }
        }
        // Add published versions
        if (publishedEntry) {
            result.published = { default: processEntry(publishedEntry) };
            if (this.context.options.exportAllLocales && ((_c = publishedEntry.localizations) === null || _c === void 0 ? void 0 : _c.length)) {
                for (const publishedLoc of publishedEntry.localizations) {
                    const locale = publishedLoc.locale;
                    if (!locale)
                        continue;
                    result.published[locale] = processEntry(publishedLoc);
                }
            }
        }
        return result;
    }
    processDataWithSchema(data, schema, options = {
        processLocalizations: true,
    }, skipRelationsOverride = null) {
        var _a, _b;
        if (!data)
            return null;
        const processed = { ...data };
        delete processed.id;
        delete processed.documentId;
        delete processed.createdBy;
        delete processed.updatedBy;
        // Only remove localizations if not specifically processing them
        if (!options.processLocalizations) {
            delete processed.localizations;
        }
        for (const [key, attr] of Object.entries(schema.attributes)) {
            if (data[key] === undefined || data[key] === null)
                continue;
            if (key === 'localizations' && options.processLocalizations) {
                processed[key] =
                    ((_a = data[key]) === null || _a === void 0 ? void 0 : _a.map((localization) => ({
                        ...this.processDataWithSchema(localization, schema, { processLocalizations: false }),
                        documentId: localization.documentId,
                    }))) || [];
                continue;
            }
            try {
                if ((0, models_1.isRelationAttribute)(attr)) {
                    console.log('PROCESSING RELATION', attr);
                    processed[key] = this.processRelation(data[key], attr.target, attr, skipRelationsOverride);
                }
                else if ((0, models_1.isComponentAttribute)(attr)) {
                    if (attr.repeatable) {
                        processed[key] =
                            ((_b = data[key]) === null || _b === void 0 ? void 0 : _b.map((item) => this.processComponent(item, attr.component))) || [];
                    }
                    else {
                        processed[key] = this.processComponent(data[key], attr.component);
                    }
                }
                else if ((0, models_1.isDynamicZoneAttribute)(attr)) {
                    processed[key] = this.processDynamicZone(data[key]);
                }
                else if ((0, models_1.isMediaAttribute)(attr)) {
                    processed[key] = this.processMedia(data[key], attr);
                }
            }
            catch (error) {
                logger_1.logger.error(`Failed to process attribute`, {
                    operation: 'export',
                    attribute: key,
                    contentType: schema.uid,
                }, error);
                processed[key] = null;
            }
        }
        return processed;
    }
    processRelation(item, targetModelUid, attr, skipRelationsOverride = null) {
        if (!item)
            return null;
        if (Array.isArray(item) && item.length === 0)
            return [];
        const targetModel = (0, models_1.getModel)(targetModelUid);
        if (!targetModel || targetModel.uid === 'admin::user')
            return null;
        const idField = (0, identifiers_1.getIdentifierField)(targetModel);
        const skipRelations = skipRelationsOverride !== null && skipRelationsOverride !== void 0 ? skipRelationsOverride : this.context.options.skipRelations;
        if (attr.relation.endsWith('Many') || attr.relation === 'manyWay') {
            if (!Array.isArray(item)) {
                logger_1.logger.warn('Expected array for many relation', { targetModelUid });
                return [];
            }
            return item.map((relItem) => {
                if (!skipRelations && !this.context.wasProcessed(relItem.documentId)) {
                    this.context.addRelation(targetModelUid, relItem.documentId);
                }
                return relItem[idField];
            });
        }
        else {
            if (Array.isArray(item)) {
                logger_1.logger.warn('Expected single item for one relation', { targetModelUid });
                return null;
            }
            if (!skipRelations && !this.context.wasProcessed(item.documentId)) {
                this.context.addRelation(targetModelUid, item.documentId);
            }
            return item[idField];
        }
    }
    processComponent(item, componentUid) {
        if (!item)
            return null;
        const componentModel = (0, models_1.getModel)(componentUid);
        if (!componentModel)
            return null;
        return this.processDataWithSchema(item, componentModel, {
            processLocalizations: this.context.options.exportAllLocales,
        }, this.context.options.skipComponentRelations);
    }
    processDynamicZone(items) {
        if (!Array.isArray(items))
            return [];
        return items
            .map((item) => {
            const componentModel = (0, models_1.getModel)(item.__component);
            if (!componentModel)
                return null;
            return {
                __component: item.__component,
                ...this.processDataWithSchema(item, componentModel, {
                    processLocalizations: this.context.options.exportAllLocales,
                }, this.context.options.skipComponentRelations),
            };
        })
            .filter(Boolean);
    }
    processMedia(item, attr) {
        if (!item)
            return null;
        const processMediaItem = (mediaItem) => ({
            url: mediaItem.url.startsWith('/') ? this.computeUrl(mediaItem.url) : mediaItem.url,
            name: mediaItem.name,
            caption: mediaItem.caption,
            hash: mediaItem.hash,
            alternativeText: mediaItem.alternativeText,
            createdAt: mediaItem.createdAt,
            updatedAt: mediaItem.updatedAt,
            publishedAt: mediaItem.publishedAt,
        });
        if (attr.multiple) {
            return Array.isArray(item) ? item.map(processMediaItem) : [];
        }
        return processMediaItem(item);
    }
    computeUrl(relativeUrl) {
        return (0, getConfig_1.getConfig)('serverPublicHostname') + relativeUrl;
    }
    areVersionsEqual(version1, version2, excludeFields = ['publishedAt']) {
        const v1 = { ...version1 };
        const v2 = { ...version2 };
        excludeFields.forEach((field) => {
            delete v1[field];
            delete v2[field];
        });
        return JSON.stringify(v1) === JSON.stringify(v2);
    }
    getExportData() {
        return JSON.stringify({
            version: 3,
            data: this.context.exportedData,
        }, null, '\t');
    }
}
exports.ExportProcessor = ExportProcessor;
