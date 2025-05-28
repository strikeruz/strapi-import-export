"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const import_1 = require("./import");
const import_v2_1 = require("./import-v2");
const import_v3_1 = require("./import-v3");
const parsers_1 = require("./parsers");
const sse_manager_1 = require("./sse-manager");
let importInProgress = false;
const isImportInProgress = () => {
    return importInProgress;
};
const setImportInProgress = (status) => {
    importInProgress = status;
};
const setSSEClient = (client) => {
    sse_manager_1.sseManager.setClient(client);
};
const clearSSEClient = () => {
    sse_manager_1.sseManager.clearClient();
};
// Wrap the importDataV3 function to track progress state
const wrappedImportDataV3 = async (fileContent, options, progressOptions) => {
    if ((progressOptions === null || progressOptions === void 0 ? void 0 : progressOptions.useSSE) && importInProgress) {
        throw new Error('An import is already in progress');
    }
    if (progressOptions === null || progressOptions === void 0 ? void 0 : progressOptions.useSSE) {
        setImportInProgress(true);
        try {
            const result = await (0, import_v3_1.importDataV3)(fileContent, options, progressOptions);
            // If we're not doing background processing, we're done
            if (!result.backgroundProcessing) {
                setImportInProgress(false);
            }
            return result;
        }
        catch (error) {
            setImportInProgress(false);
            throw error;
        }
    }
    else {
        // Normal import without SSE
        return (0, import_v3_1.importDataV3)(fileContent, options, progressOptions);
    }
};
const importService = {
    importData: import_1.importData,
    importDataV2: import_v2_1.importDataV2,
    parseInputData: parsers_1.parseInputData,
    isImportInProgress,
    setImportInProgress,
    setSSEClient,
    clearSSEClient,
    importDataV3: wrappedImportDataV3,
};
exports.default = importService;
