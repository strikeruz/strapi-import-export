"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.attributeIsUnique = attributeIsUnique;
exports.getIdentifierField = getIdentifierField;
const pluginId_1 = __importDefault(require("../utils/pluginId"));
function attributeIsUnique(attribute) {
    return ['string', 'text', 'email', 'integer', 'biginteger', 'float', 'decimal'].includes(attribute.type);
}
function getIdentifierField(model) {
    var _a;
    console.log('getIdentifierField for model:', model.uid);
    // Check for configured idField in plugin options
    const importExportOptions = (_a = model.pluginOptions) === null || _a === void 0 ? void 0 : _a[pluginId_1.default];
    if (importExportOptions === null || importExportOptions === void 0 ? void 0 : importExportOptions.idField) {
        const configuredField = importExportOptions.idField;
        console.log('Using configured idField:', configuredField);
        // Validate the configured field exists and is properly set up
        const attribute = model.attributes[configuredField];
        if (!attribute) {
            throw new Error(`Configured idField '${configuredField}' not found in model '${model.uid}'`);
        }
        if (attributeIsUnique(attribute) && (!attribute.required || !attribute.unique)) {
            throw new Error(`Configured idField '${configuredField}' in model '${model.uid}' must be both required and unique. ` +
                `Current settings - required: ${!!attribute.required}, unique: ${!!attribute.unique}`);
        }
        return configuredField;
    }
    // Check for standard identifier fields in order
    const attributes = model.attributes || {};
    console.log('Looking for identifier in attributes:', Object.keys(attributes));
    if (attributes.uid)
        return 'uid';
    if (attributes.name)
        return 'name';
    if (attributes.title)
        return 'title';
    console.log('Falling back to id');
    return 'id';
}
