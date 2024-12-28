import { importData } from './import';
import { importDataV2 } from './import-v2';
import { importDataV3 } from './import-v3';
import { parseInputData } from './parsers';

const importService = {
  importData,
  importDataV2,
  importDataV3,
  parseInputData,
};

export default importService;
