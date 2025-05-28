"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllSlugs = getAllSlugs;
exports.getModel = getModel;
exports.getModelFromSlugOrModel = getModelFromSlugOrModel;
exports.getModelAttributes = getModelAttributes;
exports.isComponentAttribute = isComponentAttribute;
exports.isDynamicZoneAttribute = isDynamicZoneAttribute;
exports.isMediaAttribute = isMediaAttribute;
exports.isRelationAttribute = isRelationAttribute;
exports.getEntryProp = getEntryProp;
exports.setEntryProp = setEntryProp;
exports.deleteEntryProp = deleteEntryProp;
const arrays_js_1 = require("../../libs/arrays.js");
function getAllSlugs({ includePluginsContentTypes = false } = {}) {
    return Array.from(strapi.db.metadata)
        .filter(([collectionName]) => collectionName.startsWith('api::') ||
        (includePluginsContentTypes && collectionName.startsWith('plugin::')))
        .map(([collectionName]) => collectionName);
}
function getModel(slug) {
    return strapi.getModel(slug);
}
function getModelFromSlugOrModel(modelOrSlug) {
    let model = modelOrSlug;
    if (typeof model === 'string') {
        model = getModel(modelOrSlug);
    }
    return model;
}
/**
 * Get the attributes of a model.
 */
function getModelAttributes(slug, options = {}) {
    const schema = getModel(slug);
    if (!schema) {
        return [];
    }
    // console.log(slug, JSON.stringify(schema.attributes));
    const typesToKeep = options.filterType ? (0, arrays_js_1.toArray)(options.filterType) : [];
    const typesToFilterOut = options.filterOutType ? (0, arrays_js_1.toArray)(options.filterOutType) : [];
    const targetsToFilterOut = (0, arrays_js_1.toArray)(options.filterOutTarget || []);
    let attributes = Object.keys(schema.attributes)
        .reduce((acc, key) => acc.concat({ ...schema.attributes[key], name: key }), [])
        .filter((attr) => !typesToFilterOut.includes(attr.type))
        .filter((attr) => !targetsToFilterOut.includes(attr.target));
    if (typesToKeep.length) {
        attributes = attributes.filter((attr) => typesToKeep.includes(attr.type));
    }
    // console.log(JSON.stringify(attributes));
    return attributes;
}
function isComponentAttribute(attribute) {
    return attribute.type === 'component';
}
function isDynamicZoneAttribute(attribute) {
    return attribute.type === 'dynamiczone';
}
function isMediaAttribute(attribute) {
    return attribute.type === 'media';
}
function isRelationAttribute(attribute) {
    return attribute.type === 'relation';
}
function getEntryProp(entry, prop) {
    return entry[prop];
}
function setEntryProp(entry, prop, value) {
    entry[prop] = value;
}
function deleteEntryProp(entry, prop) {
    delete entry[prop];
}
