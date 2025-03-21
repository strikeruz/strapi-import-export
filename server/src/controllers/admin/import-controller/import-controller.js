import getModelAttributesFunc from './get-model-attributes.js';
import importDataFunc from './import-data.js';
import importSSEFunc from './import-sse.js';

const importController = ({ strapi }) => ({
  getModelAttributes: getModelAttributesFunc({ strapi }),
  importData: importDataFunc({ strapi }),
  importSSE: importSSEFunc({ strapi }),
});

export default importController;
