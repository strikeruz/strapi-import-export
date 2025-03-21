import Joi from 'joi';
import { InputFormats } from '../../../services/import/parsers.js';
import { getService } from '../../../utils/utils.js';
import { checkParams, handleAsyncError } from '../utils.js';

const bodySchema = Joi.object({
  slug: Joi.string().required(),
  data: Joi.any().required(),
  format: Joi.string()
    .valid(...InputFormats)
    .required(),
  idField: Joi.string(),
  existingAction: Joi.string(),
  ignoreMissingRelations: Joi.boolean().default(false),
  allowLocaleUpdates: Joi.boolean().default(false),
  disallowNewRelations: Joi.boolean().default(false),
});

const importData = async (ctx) => {
  const { user } = ctx.state;

  const { 
    slug, 
    data: dataRaw, 
    format, 
    idField,
    existingAction,
    ignoreMissingRelations,
    allowLocaleUpdates,
    disallowNewRelations
  } = checkParams(bodySchema, ctx.request.body);

  let fileContent;
  try {
    fileContent = await getService('import').parseInputData(format, dataRaw, { slug });
  } catch (error) {
    ctx.body = {
      errors: [{
        error: error.message,
        data: {
          entry: dataRaw,
          path: '',
        }
      }],
    };
    return;
  }

  let res;
  const importService = getService('import');
  
  if (fileContent?.version === 3) {
    // Check if an import is already in progress
    if (importService.isImportInProgress()) {
      ctx.body = {
        status: 'error',
        message: 'An import is already in progress'
      };
      ctx.status = 409; // Conflict
      return;
    }
    
    // For v3 imports, use SSE for progress reporting
    res = await importService.importDataV3(fileContent, {
      slug,
      user,
      existingAction,
      ignoreMissingRelations,
      allowLocaleUpdates,
      disallowNewRelations
    }, { useSSE: true });
    
    // If the import is running in the background, return a special response
    if (res.backgroundProcessing) {
      console.log("Import is running in the background");
      console.log(res);
      ctx.body = {
        status: 'started',
        useSSE: true,
      };
      return;
    }
  } else if (fileContent?.version === 2) {
    // Use existing import function for v2
    res = await importService.importDataV2(fileContent, {
      slug,
      user,
      idField,
    });
  } else {
    // Use existing import function for v1
    res = await importService.importData(dataRaw, {
      slug,
      format,
      user,
      idField,
    });
  }

  // Standard response for completed imports
  ctx.body = {
    failures: res.failures || [],
    errors: res.errors || [],
  };
};

export default ({ strapi }) => handleAsyncError(importData);
