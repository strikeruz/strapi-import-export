import { UID } from '@strapi/types';
import { EntryVersion, ExistingAction, ImportFailure } from '../import-v3';

export class ImportContext {
    // Track records by `${contentType}:${idValue}`
    private createdRecords: Set<string> = new Set();
    private updatedRecords: Set<string> = new Set();
    private processedRecords: Set<string> = new Set();

    constructor(
        public readonly options: {
            existingAction: ExistingAction;
            allowDraftOnPublished: boolean;
            ignoreMissingRelations: boolean;
        },
        public readonly importData: Record<UID.ContentType, EntryVersion[]>,
        public readonly user: any,
        public readonly failures: ImportFailure[] = []
    ) {}

    recordCreated(contentType: string, idValue: string) {
        const key = `${contentType}:${idValue}`;
        this.createdRecords.add(key);
        this.processedRecords.add(key);
    }

    recordUpdated(contentType: string, idValue: string) {
        const key = `${contentType}:${idValue}`;
        this.updatedRecords.add(key);
        this.processedRecords.add(key);
    }

    wasCreatedInThisImport(contentType: string, idValue: string): boolean {
        return this.createdRecords.has(`${contentType}:${idValue}`);
    }

    wasUpdatedInThisImport(contentType: string, idValue: string): boolean {
        return this.updatedRecords.has(`${contentType}:${idValue}`);
    }

    wasProcessedInThisImport(contentType: string, idValue: string): boolean {
        return this.processedRecords.has(`${contentType}:${idValue}`);
    }

    addFailure(error: string, data: any) {
        this.failures.push({ error, data });
    }

    getFailures(): ImportFailure[] {
        return this.failures;
    }
} 