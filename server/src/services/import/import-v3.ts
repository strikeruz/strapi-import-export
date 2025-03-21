import { Schema, UID } from '@strapi/types';
import { FileContent, validateFileContent } from './validation';
import { ImportContext } from './utils/import-context';
import { ImportProcessor } from './utils/import-processor';
import { logger } from '../../utils/logger';
import { sseManager } from './sse-manager';

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
    details?: any;
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
    backgroundProcessing?: boolean;
}

export interface LocaleVersions {
    [locale: string]: Record<string, any>;
}

export interface EntryVersion {
    draft?: LocaleVersions;
    published?: LocaleVersions;
}

interface ImportProgressOptions {
    useSSE?: boolean;
    onProgress?: (progress: number, message: string) => void;
}

async function importDataV3(fileContent: FileContent, { 
    slug, 
    user,
    allowDraftOnPublished = true,
    existingAction = ExistingAction.Warn,
    ignoreMissingRelations = false,
    allowLocaleUpdates = false,
    disallowNewRelations = true
}: ImportOptions, progressOptions?: ImportProgressOptions): Promise<ImportResult> {
    const context = {
        operation: 'import',
        slug
    };
    
    const { useSSE = false } = progressOptions || {};

    // validate file content
    if (!fileContent.data) {
        logger.error('No data found in file', context);
        throw new Error('No data found in file');
    }

    // Run validation first
    if (useSSE) {
        sseManager.updateStatus('validating', 'Validating data structure...', 10);
    }
    
    const validationResult = await validateFileContent(fileContent, { 
        existingAction,
        ignoreMissingRelations 
    });

    if (!validationResult.isValid) {
        const errors = validationResult.errors.map(error => {
            logger.error('Validation failed', {
                ...context,
                error: error.message,
                path: error.path
            });
            return {
                error: error.message,
                data: {
                    entry: error.entry,
                    path: error.path ? error.path.join('.') : undefined
                }
            }
        });
        
        // Send error through SSE if enabled
        if (useSSE) {
            sseManager.updateStatus('error', 'Validation failed', 0);
        }
        
        return { errors };
    }

    logger.debug('Validation passed, creating import context', context);

    // If SSE is enabled, we'll start the process in the background
    if (useSSE) {
        // Start background processing
        setTimeout(async () => {
            try {
                sseManager.updateStatus('processing', 'Creating import context...', 30);
                
                // Create context and processor
                const importContext = new ImportContext(
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

                const processor = new ImportProcessor(importContext, {
                    documents: strapi.documents,
                },
                    (progress, message) => {
                        // Report progress through SSE
                        sseManager.updateStatus('processing', message, 30 + Math.floor(progress * 70));
                    }
                );

                // Process the import
                logger.info('Starting import processing', context);
                sseManager.updateStatus('processing', 'Starting data import...', 40);
                
                const result = await processor.process();
                
                // Send completion event - this will also set importInProgress to false
                sseManager.sendComplete(result);
            } catch (error) {
                logger.error('Import processing error', {
                    ...context,
                    error: error.message,
                    stack: error.stack
                });
                // Send error - this will also set importInProgress to false
                sseManager.updateStatus('error', error.message, 0);
                sseManager.sendError(error);
            }
        }, 100);
        
        // Return empty result to indicate background processing
        return { backgroundProcessing: true };
    }

    // For non-SSE requests, continue with regular synchronous processing
    // Create context and processor
    const importContext = new ImportContext(
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

    const processor = new ImportProcessor(importContext, {
        documents: strapi.documents
    });

    // Process the import
    logger.info('Starting import processing', context);
    return processor.process();
}

export {
    importDataV3
}; 