import { Schema, UID } from '@strapi/types';
import { FileContent, validateFileContent } from './validation';
import { ImportContext } from './utils/import-context';
import { ImportProcessor } from './utils/import-processor';
import { logger } from '../../utils/logger';

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

async function importDataV3(fileContent: FileContent, { 
    slug, 
    user,
    allowDraftOnPublished = true,
    existingAction = ExistingAction.Warn,
    ignoreMissingRelations = false,
    allowLocaleUpdates = false,
    disallowNewRelations = true
}: ImportOptions): Promise<ImportResult> {
    const context = {
        operation: 'import',
        slug
    };

    // validate file content
    if (!fileContent.data) {
        logger.error('No data found in file', context);
        throw new Error('No data found in file');
    }

    const validationResult = await validateFileContent(fileContent, { 
        existingAction,
        ignoreMissingRelations 
    });

    if (!validationResult.isValid) {
        return {
            errors: validationResult.errors.map(error => {
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
            })
        };
    }

    logger.debug('Validation passed, creating import context', context);

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