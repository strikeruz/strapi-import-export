"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExportContext = void 0;
class ExportContext {
    constructor(options, exportedData = {}, processedRelations = {}) {
        this.options = options;
        this.exportedData = exportedData;
        this.processedRelations = processedRelations;
        this.processedDocumentIds = new Set();
        this.relations = {};
    }
    recordProcessed(documentId) {
        this.processedDocumentIds.add(documentId);
    }
    wasProcessed(documentId) {
        return this.processedDocumentIds.has(documentId);
    }
    addRelation(contentType, documentId) {
        if (!this.relations[contentType]) {
            this.relations[contentType] = [];
        }
        if (!this.relations[contentType].includes(documentId)) {
            this.relations[contentType].push(documentId);
        }
    }
    getRelations() {
        return this.relations;
    }
    clearRelations() {
        this.relations = {};
    }
    setSkipRelations(skip) {
        this.options.skipRelations = skip;
    }
    setSkipComponentRelations(skip) {
        this.options.skipComponentRelations = skip;
    }
    setDocumentIds(documentIds) {
        this.options.documentIds = documentIds;
    }
}
exports.ExportContext = ExportContext;
