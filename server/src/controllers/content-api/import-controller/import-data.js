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
  if (fileContent?.version === 3) {
    res = await getService('import').importDataV3(fileContent, {
      slug,
      user,
      existingAction,
      ignoreMissingRelations,
      allowLocaleUpdates,
      disallowNewRelations
    });
  } else if (fileContent?.version === 2) {
    res = await getService('import').importDataV2(fileContent, {
      slug,
      user,
      idField,
    });
  } else {
    res = await getService('import').importData(dataRaw, {
      slug,
      format,
      user,
      idField,
    });
  }

  ctx.body = {
    failures: res.failures || [],
    errors: res.errors || [],
  };
};

export default ({ strapi }) => handleAsyncError(importData);
