"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_js_1 = require("../../../config/constants.js");
const utils_js_1 = require("../../../utils/utils.js");
const models_1 = require("../../../utils/models");
const utils_js_2 = require("../../content-api/utils.js");
const exportData = async (ctx) => {
    if (!hasPermissions(ctx)) {
        return ctx.forbidden();
    }
    let data;
    const { data: dataRaw } = ctx.request.body;
    const { slug, search, applySearch, exportFormat, relationsAsId, deepness = 5, exportPluginsContentTypes, documentIds, exportAllLocales = false, exportRelations = false, deepPopulateRelations = false, deepPopulateComponentRelations = false, } = dataRaw;
    console.log('exportFormat', exportFormat);
    try {
        if (exportFormat === (0, utils_js_1.getService)('export').formats.JSON_V3) {
            console.log('exportDataV3');
            data = await (0, utils_js_1.getService)('export').exportDataV3({
                slug,
                search,
                applySearch,
                exportPluginsContentTypes,
                documentIds,
                maxDepth: deepness,
                exportAllLocales,
                exportRelations,
                deepPopulateRelations,
                deepPopulateComponentRelations,
            });
        }
        else if (exportFormat === (0, utils_js_1.getService)('export').formats.JSON_V2) {
            console.log('exportDataV2');
            data = await (0, utils_js_1.getService)('export').exportDataV2({
                slug,
                search,
                applySearch,
                deepness,
                exportPluginsContentTypes,
            });
        }
        else {
            console.log('exportData');
            data = await (0, utils_js_1.getService)('export').exportData({
                slug,
                search,
                applySearch,
                exportFormat,
                relationsAsId,
                deepness,
            });
        }
        ctx.body = {
            data,
        };
    }
    catch (error) {
        console.log('error', error);
        if (error.message.includes('IdField not found in model')) {
            ctx.preconditionFailed(error.message, {
                cause: 'IdField Not Found',
            });
        }
        else if (error.message.includes('IdField misconfigured in model')) {
            ctx.preconditionFailed(error.message, {
                cause: 'IdField Configuration Error',
            });
        }
        else {
            ctx.badRequest(error.message);
        }
    }
};
const hasPermissions = (ctx) => {
    const { data } = ctx.request.body;
    const { slug } = data;
    const { userAbility } = ctx.state;
    const slugs = slug === constants_js_1.CustomSlugs.WHOLE_DB ? (0, models_1.getAllSlugs)() : [slug];
    const allowedSlugs = slugs.filter((slug) => {
        const permissionChecker = strapi
            .plugin('content-manager')
            .service('permission-checker')
            .create({ userAbility, model: slug });
        return permissionChecker.can.read();
    });
    return !!allowedSlugs.length;
};
exports.default = ({ strapi }) => ({
    exportData: (0, utils_js_2.handleAsyncError)(exportData),
});
