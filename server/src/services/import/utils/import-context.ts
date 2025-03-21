import { UID } from '@strapi/types';
import { EntryVersion, ExistingAction, ImportFailure } from '../import-v3';

interface ProcessedRecordInfo {
    contentType: string;
    idValue: string;
}

export class ImportContext {
    // Track records by `${contentType}:${idValue}` -> documentId
    private createdDocumentIds: Set<string> = new Set();
    private updatedDocumentIds: Set<string> = new Set();
    private processedRecords: Map<string, string> = new Map(); // `${contentType}:${idValue}` -> documentId
    private processedRecordsByDocumentId: Map<string, ProcessedRecordInfo> = new Map(); // documentId -> { contentType, idValue }

    constructor(
        public readonly options: {
            existingAction: ExistingAction;
            allowDraftOnPublished: boolean;
            ignoreMissingRelations: boolean;
            allowLocaleUpdates: boolean;
            disallowNewRelations: boolean;
        },
        public readonly importData: Record<UID.ContentType, EntryVersion[]>,
        public readonly user: any,
        public readonly failures: ImportFailure[] = []
    ) {}

    recordCreated(contentType: string, idValue: string | undefined, documentId: string) {
        const key = `${contentType}:${idValue ?? 'SINGLE_TYPE'}`;
        this.createdDocumentIds.add(documentId);
        this.processedRecords.set(key, documentId);
        this.processedRecordsByDocumentId.set(documentId, { contentType, idValue: idValue ?? 'SINGLE_TYPE' });
    }

    recordUpdated(contentType: string, idValue: string | undefined, documentId: string) {
        const key = `${contentType}:${idValue ?? 'SINGLE_TYPE'}`;
        this.updatedDocumentIds.add(documentId);
        this.processedRecords.set(key, documentId);
        this.processedRecordsByDocumentId.set(documentId, { contentType, idValue: idValue ?? 'SINGLE_TYPE' });
    }

    wasDocumentCreatedInThisImport(documentId: string): boolean {
        return this.createdDocumentIds.has(documentId);
    }

    wasUpdatedInThisImport(contentType: string, idValue: string | undefined): boolean {
        return this.updatedDocumentIds.has(`${contentType}:${idValue ?? 'SINGLE_TYPE'}`);
    }

    findProcessedRecord(contentType: string, idValue: any): string | undefined {
        return this.processedRecords.get(`${contentType}:${idValue ?? 'SINGLE_TYPE'}`);
    }

    findProcessedRecordByDocumentId(documentId: string): ProcessedRecordInfo | undefined {
        return this.processedRecordsByDocumentId.get(documentId);
    }

    addFailure(error: string, data: any, details?: any) {
        this.failures.push({ error, data, details });
    }

    getFailures(): ImportFailure[] {
        return this.failures;
    }
} 