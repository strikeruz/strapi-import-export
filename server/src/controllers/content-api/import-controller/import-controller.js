import importData from './import-data.js';
import importSSE from './import-sse.js';

export default ({ strapi }) => ({
  importData: importData({ strapi }),
  importSSE: importSSE({ strapi }),
});
