import { CustomSlugs } from '../../../config/constants.js';
import { getAllSlugs } from '../../../utils/models';
import { getService } from '../../../utils/utils.js';

export default ({ strapi }) => importData;

async function importData(ctx) {
  if (!hasPermissions(ctx)) {
    return ctx.forbidden();
  }

  const { user } = ctx.state;
  const { data } = ctx.request.body;
  const { slug, data: dataRaw, format, idField, existingAction, ignoreMissingRelations } = data;
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

  console.log('res', JSON.stringify(res, null, 2));

  ctx.body = {
    failures: res.failures || [],
    errors: res.errors || [],
  };
}

function hasPermissions(ctx) {
  const { data } = ctx.request.body;
  const { slug } = data;
  const { userAbility } = ctx.state;

  let slugsToCheck = [];
  if (slug === CustomSlugs.WHOLE_DB) {
    slugsToCheck.push(...getAllSlugs());
  } else {
    slugsToCheck.push(slug);
  }

  return slugsToCheck.every((slug) => hasPermissionForSlug(userAbility, slug));
}

function hasPermissionForSlug(userAbility, slug) {
  const permissionChecker = strapi.plugin('content-manager').service('permission-checker').create({ userAbility, model: slug });

  return permissionChecker.can.create() && permissionChecker.can.update();
}
