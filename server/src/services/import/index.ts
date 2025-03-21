import { importData } from './import';
import { importDataV2 } from './import-v2';
import { importDataV3 } from './import-v3';
import { parseInputData } from './parsers';
import { sseManager } from './sse-manager';


let importInProgress = false;

const isImportInProgress = () => {
  return importInProgress;
};

const setImportInProgress = (status) => {
  importInProgress = status;
};

const setSSEClient = (client) => {
  sseManager.setClient(client);
};

const clearSSEClient = () => {
  sseManager.clearClient();
};

// Wrap the importDataV3 function to track progress state
const wrappedImportDataV3 = async (fileContent, options, progressOptions) => {
  if (progressOptions?.useSSE && importInProgress) {
    throw new Error('An import is already in progress');
  }
  
  if (progressOptions?.useSSE) {
    setImportInProgress(true);
    
    try {
      const result = await importDataV3(fileContent, options, progressOptions);
      
      // If we're not doing background processing, we're done
      if (!result.backgroundProcessing) {
        setImportInProgress(false);
      }
      
      return result;
    } catch (error) {
      setImportInProgress(false);
      throw error;
    }
  } else {
    // Normal import without SSE
    return importDataV3(fileContent, options, progressOptions);
  }
};

const importService = {
  importData,
  importDataV2,
  parseInputData,
  isImportInProgress,
  setImportInProgress,
  setSSEClient,
  clearSSEClient,
  importDataV3: wrappedImportDataV3,
};

export default importService;
