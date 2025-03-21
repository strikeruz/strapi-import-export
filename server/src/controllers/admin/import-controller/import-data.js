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
  const { 
    slug, 
    data: dataRaw, 
    format, 
    idField, 
    existingAction, 
    ignoreMissingRelations,
    allowLocaleUpdates,
    disallowNewRelations
  } = data;
  
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

  // Check for ongoing imports for v3 only (which supports SSE)
  const importService = getService('import');
  if (fileContent?.version === 3 && importService.isImportInProgress()) {
    ctx.body = {
      status: 'error',
      message: 'An import is already in progress'
    };
    ctx.status = 409; // Conflict
    return;
  }

  let res;
  if (fileContent?.version === 3) {
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
