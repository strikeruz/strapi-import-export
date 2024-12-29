import { CustomSlugs } from '../../../config/constants.js';
import { getService } from '../../../utils/utils.js';
import { getAllSlugs } from '../../../utils/models';
import { handleAsyncError } from '../../content-api/utils.js';

import type { Context } from 'koa';

import type { Core } from '@strapi/strapi';

const exportData: Core.ControllerHandler = async (ctx) => {
  if (!hasPermissions(ctx)) {
    return ctx.forbidden();
  }

  let data;
  const { data: dataRaw } = ctx.request.body;
  const { slug, search, applySearch, exportFormat, relationsAsId, deepness = 5, exportPluginsContentTypes, documentIds } = dataRaw;
  
  console.log('exportFormat', exportFormat);

  try {
    if (exportFormat === getService('export').formats.JSON_V3) {
      console.log('exportDataV3');
      data = await getService('export').exportDataV3({ slug, search, applySearch, exportPluginsContentTypes, documentIds });
    } else if (exportFormat === getService('export').formats.JSON_V2) {
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
    console.log('error', error);
    if (error.message.includes('IdField not found in model')) {
      ctx.preconditionFailed(error.message, {
        cause: 'IdField Not Found',
      });
    } else if (error.message.includes('IdField misconfigured in model')) {
      ctx.preconditionFailed(error.message, {
        cause: 'IdField Configuration Error',
      });
    } else {
      ctx.badRequest(error.message);
    }
  }
};

const hasPermissions = (ctx) => {
  const { data } = ctx.request.body;
  const {slug } = data
  const { userAbility } = ctx.state;

  const slugs = slug === CustomSlugs.WHOLE_DB ? getAllSlugs() : [slug];

  const allowedSlugs = slugs.filter((slug) => {
    const permissionChecker = strapi.plugin('content-manager').service('permission-checker').create({ userAbility, model: slug });
    return permissionChecker.can.read();
  });

  return !!allowedSlugs.length;
};

export default ({ strapi }) => ({
  exportData: handleAsyncError(exportData),
});
