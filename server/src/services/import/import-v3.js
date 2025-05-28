"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExistingAction = void 0;
exports.importDataV3 = importDataV3;
const validation_1 = require("./validation");
const import_context_1 = require("./utils/import-context");
const import_processor_1 = require("./utils/import-processor");
const logger_1 = require("../../utils/logger");
const sse_manager_1 = require("./sse-manager");
var ExistingAction;
(function (ExistingAction) {
    ExistingAction["Warn"] = "warn";
    ExistingAction["Update"] = "update";
    ExistingAction["Skip"] = "skip";
})(ExistingAction || (exports.ExistingAction = ExistingAction = {}));
async function importDataV3(fileContent, { slug, user, allowDraftOnPublished = true, existingAction = ExistingAction.Warn, ignoreMissingRelations = false, allowLocaleUpdates = false, disallowNewRelations = true, createMissingEntities = false, }, progressOptions) {
    const context = {
        operation: 'import',
        slug,
    };
    const { useSSE = false } = progressOptions || {};
    // validate file content
    if (!fileContent.data) {
        logger_1.logger.error('No data found in file', context);
        throw new Error('No data found in file');
    }
    // Run validation first
    if (useSSE) {
        sse_manager_1.sseManager.updateStatus('validating', 'Validating data structure...', 10);
    }
    const validationResult = await (0, validation_1.validateFileContent)(fileContent, {
        existingAction,
        ignoreMissingRelations,
    });
    if (!validationResult.isValid) {
        const errors = validationResult.errors.map((error) => {
            logger_1.logger.error('Validation failed', {
                ...context,
                error: error.message,
                path: error.path,
            });
            return {
                error: error.message,
                data: {
                    entry: error.entry,
                    path: error.path ? error.path.join('.') : undefined,
                },
            };
        });
        // Send error through SSE if enabled
        if (useSSE) {
            sse_manager_1.sseManager.updateStatus('error', 'Validation failed', 0);
        }
        return { errors };
    }
    logger_1.logger.debug('Validation passed, creating import context', context);
    // If SSE is enabled, we'll start the process in the background
    if (useSSE) {
        // Start background processing
        setTimeout(async () => {
            try {
                sse_manager_1.sseManager.updateStatus('processing', 'Creating import context...', 30);
                // Create context and processor
                const importContext = new import_context_1.ImportContext({
                    existingAction,
                    allowDraftOnPublished,
                    ignoreMissingRelations,
                    allowLocaleUpdates,
                    disallowNewRelations,
                    createMissingEntities,
                }, fileContent.data, user);
                const processor = new import_processor_1.ImportProcessor(importContext, {
                    documents: strapi.documents,
                }, (progress, message) => {
                    // Report progress through SSE
                    sse_manager_1.sseManager.updateStatus('processing', message, 30 + Math.floor(progress * 70));
                });
                // Process the import
                logger_1.logger.info('Starting import processing', context);
                sse_manager_1.sseManager.updateStatus('processing', 'Starting data import...', 40);
                const result = await processor.process();
                // Send completion event - this will also set importInProgress to false
                sse_manager_1.sseManager.sendComplete(result);
            }
            catch (error) {
                logger_1.logger.error('Import processing error', {
                    ...context,
                    error: error.message,
                    stack: error.stack,
                });
                // Send error - this will also set importInProgress to false
                sse_manager_1.sseManager.updateStatus('error', error.message, 0);
                sse_manager_1.sseManager.sendError(error);
            }
        }, 100);
        // Return empty result to indicate background processing
        return { backgroundProcessing: true };
    }
    // For non-SSE requests, continue with regular synchronous processing
    // Create context and processor
    const importContext = new import_context_1.ImportContext({
        existingAction,
        allowDraftOnPublished,
        ignoreMissingRelations,
        allowLocaleUpdates,
        disallowNewRelations,
        createMissingEntities,
    }, fileContent.data, user);
    const processor = new import_processor_1.ImportProcessor(importContext, {
        documents: strapi.documents,
    });
    // Process the import
    logger_1.logger.info('Starting import processing', context);
    return processor.process();
}
