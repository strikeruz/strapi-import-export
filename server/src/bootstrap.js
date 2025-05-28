"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pluginId_1 = require("../../admin/src/pluginId");
const actions = [
    {
        section: 'plugins',
        displayName: 'Import',
        uid: 'import',
        pluginName: pluginId_1.PLUGIN_ID,
    },
    {
        section: 'plugins',
        displayName: 'Export',
        uid: 'export',
        pluginName: pluginId_1.PLUGIN_ID,
    },
];
const bootstrap = ({ strapi }) => {
    strapi.admin.services.permission.actionProvider.registerMany(actions);
    // bootstrap phase
};
exports.default = bootstrap;
