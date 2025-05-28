"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportContext = void 0;
class ImportContext {
    constructor(options, importData, user, failures = []) {
        this.options = options;
        this.importData = importData;
        this.user = user;
        this.failures = failures;
        // Track records by `${contentType}:${idValue}` -> documentId
        this.createdDocumentIds = new Set();
        this.updatedDocumentIds = new Set();
        this.processedRecords = new Map(); // `${contentType}:${idValue}` -> documentId
        this.processedRecordsByDocumentId = new Map(); // documentId -> { contentType, idValue }
    }
    recordCreated(contentType, idValue, documentId) {
        const key = `${contentType}:${idValue !== null && idValue !== void 0 ? idValue : 'SINGLE_TYPE'}`;
        this.createdDocumentIds.add(documentId);
        this.processedRecords.set(key, documentId);
        this.processedRecordsByDocumentId.set(documentId, {
            contentType,
            idValue: idValue !== null && idValue !== void 0 ? idValue : 'SINGLE_TYPE',
        });
    }
    recordUpdated(contentType, idValue, documentId) {
        const key = `${contentType}:${idValue !== null && idValue !== void 0 ? idValue : 'SINGLE_TYPE'}`;
        this.updatedDocumentIds.add(documentId);
        this.processedRecords.set(key, documentId);
        this.processedRecordsByDocumentId.set(documentId, {
            contentType,
            idValue: idValue !== null && idValue !== void 0 ? idValue : 'SINGLE_TYPE',
        });
    }
    wasDocumentCreatedInThisImport(documentId) {
        return this.createdDocumentIds.has(documentId);
    }
    wasUpdatedInThisImport(contentType, idValue) {
        return this.updatedDocumentIds.has(`${contentType}:${idValue !== null && idValue !== void 0 ? idValue : 'SINGLE_TYPE'}`);
    }
    findProcessedRecord(contentType, idValue) {
        return this.processedRecords.get(`${contentType}:${idValue !== null && idValue !== void 0 ? idValue : 'SINGLE_TYPE'}`);
    }
    findProcessedRecordByDocumentId(documentId) {
        return this.processedRecordsByDocumentId.get(documentId);
    }
    addFailure(error, data, details) {
        this.failures.push({ error, data, details });
    }
    getFailures() {
        return this.failures;
    }
}
exports.ImportContext = ImportContext;
