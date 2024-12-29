import Joi from 'joi';

import { getService } from '../../../utils/utils';
import { checkParams, handleAsyncError } from '../utils';
import { exportDataV3 } from '../../../services/export/export-v3';

const bodySchema = Joi.object({
  slug: Joi.string().required(),
  exportFormat: Joi.string().valid('csv', 'json', 'json-v2', 'json-v3').required(),
  search: Joi.string().default(''),
  applySearch: Joi.boolean().default(false),
  relationsAsId: Joi.boolean().default(false),
  deepness: Joi.number().integer().min(1).default(5),
  exportPluginsContentTypes: Joi.boolean().default(false),
});

const exportData = async (ctx) => {
  let { slug, search, applySearch, exportFormat, relationsAsId, deepness, exportPluginsContentTypes } = checkParams(bodySchema, ctx.request.body);

  let data;
  console.log('exportFormat', exportFormat);
  try {
    if (exportFormat === 'json-v3') {
      console.log('exportDataV3');
      data = await exportDataV3({ slug, search, applySearch, exportPluginsContentTypes });
    } else if (exportFormat === 'json-v2') {
      console.log('exportDataV2');
      data = await getService('export').exportDataV2({ slug, search, applySearch, deepness, exportPluginsContentTypes });
    } else {
      console.log('exportData');
      data = await getService('export').exportData({ slug, search, applySearch, exportFormat, relationsAsId, deepness });
    }

    ctx.body = {
      data,
    };
  } catch (error) {
    if (error.message.includes('must be both required and unique')) {
      return ctx.preconditionFailed({
        error: 'IdField Configuration Error',
        // message: error.message
      });
    }
    throw error;
  }
};

export default ({ strapi }) => ({
  exportData: handleAsyncError(exportData),
});
