"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateFileContent = validateFileContent;
const models_1 = require("../../utils/models");
const identifiers_1 = require("../../utils/identifiers");
const import_v3_1 = require("./import-v3");
const validation_1 = require("../export/validation");
function createValidationError(message, path, entry) {
    return { message, path, entry };
}
async function validateFileContent(fileContent, options = {}) {
    if (!fileContent.version || fileContent.version !== 3) {
        return {
            isValid: false,
            errors: [createValidationError('Invalid file version. Expected version 3.')],
        };
    }
    if (!fileContent.data || typeof fileContent.data !== 'object') {
        return {
            isValid: false,
            errors: [createValidationError('Invalid file structure. Expected data object.')],
        };
    }
    const errors = [];
    await validateContentTypes(fileContent.data, errors, options.existingAction, options.ignoreMissingRelations, fileContent.data);
    return {
        isValid: errors.length === 0,
        errors,
    };
}
async function validateContentTypes(data, errors, existingAction, ignoreMissingRelations, importData) {
    for (const [contentType, entries] of Object.entries(data)) {
        const model = (0, models_1.getModel)(contentType);
        if (!model) {
            errors.push(createValidationError(`Model ${contentType} not found`, [contentType]));
            continue;
        }
        try {
            validateModelConfiguration(model);
            await validateContentTypeEntries(contentType, entries, errors, existingAction, ignoreMissingRelations, importData);
        }
        catch (error) {
            errors.push(createValidationError(`Validation failed for ${contentType}: ${error.message}`, [
                contentType,
            ]));
        }
    }
}
async function validateContentTypeEntries(contentType, entries, errors, existingAction, ignoreMissingRelations, importData) {
    try {
        const model = (0, models_1.getModel)(contentType);
        for (const entry of entries) {
            for (const [version, localeVersions] of Object.entries(entry)) {
                for (const [locale, data] of Object.entries(localeVersions)) {
                    const path = [contentType, version, locale];
                    // Structure validation
                    await validateStructure(data, model, path, errors);
                    // Content validation
                    await validateContent(data, model, path, errors, ignoreMissingRelations, importData);
                    // Constraint validation
                    if (version === 'published') {
                        await validateConstraints(data, model, path, errors, existingAction);
                    }
                }
            }
        }
    }
    catch (error) {
        errors.push(createValidationError(`Error validating entries for ${contentType}: ${error.message}`, [
            contentType,
        ]));
        console.error(error);
    }
}
// Validates the structure of the data (unknown fields, media format)
async function validateStructure(data, model, path, errors, isDynamicZoneComponent = false) {
    validateUnknownFields(data, model, path, errors, isDynamicZoneComponent);
    validateMediaFields(data, model, path, errors);
    // Recursively validate components and dynamic zones structure
    await validateComponentStructure(data, model, path, errors);
}
async function validateComponentStructure(data, model, path, errors) {
    if (!data || typeof data !== 'object')
        return;
    for (const [fieldName, attr] of Object.entries(model.attributes)) {
        const value = data[fieldName];
        if (!value)
            continue;
        if ((0, models_1.isComponentAttribute)(attr)) {
            const componentModel = (0, models_1.getModel)(attr.component);
            if (Array.isArray(value)) {
                await Promise.all(value.map((item, index) => validateStructure(item, componentModel, [...path, fieldName, index.toString()], errors)));
            }
            else {
                await validateStructure(value, componentModel, [...path, fieldName], errors);
            }
        }
        else if ((0, models_1.isDynamicZoneAttribute)(attr)) {
            if (!Array.isArray(value)) {
                errors.push(createValidationError('Dynamic zone must be an array', [...path, fieldName], value));
                continue;
            }
            await Promise.all(value.map(async (item, index) => {
                // First validate the __component field
                if (!item || typeof item !== 'object') {
                    errors.push(createValidationError('Dynamic zone item must be an object', [...path, fieldName, index.toString()], item));
                    return;
                }
                if (!item.__component) {
                    errors.push(createValidationError('Dynamic zone item missing __component field', [...path, fieldName, index.toString()], item));
                    return;
                }
                // Validate that __component is one of the allowed values
                if (!attr.components.includes(item.__component)) {
                    errors.push(createValidationError(`Invalid component type '${item.__component}'. Allowed types are: ${attr.components.join(', ')}`, [...path, fieldName, index.toString(), '__component'], item.__component));
                    return;
                }
                // If component type is valid, proceed with structure validation
                const componentModel = (0, models_1.getModel)(item.__component);
                if (componentModel) {
                    await validateStructure(item, componentModel, [...path, fieldName, index.toString()], errors, true);
                }
            }));
        }
    }
}
// Validates the content (required fields, relations)
async function validateContent(data, model, path, errors, ignoreMissingRelations, importData) {
    // First handle required fields
    const requiredAttributes = Object.entries(model.attributes).filter(([_, attr]) => attr.required);
    await Promise.all(requiredAttributes.map(async ([fieldName, attr]) => {
        const value = data[fieldName];
        if (value === undefined || value === null) {
            errors.push(createValidationError(`Required field '${fieldName}' is missing`, [...path, fieldName], data));
            return;
        }
        if ((0, models_1.isRelationAttribute)(attr)) {
            await validateRequiredRelation(attr, value, path, errors, fieldName);
        }
    }));
    // Then validate all relations if not ignored
    if (!ignoreMissingRelations) {
        const relationAttributes = Object.entries(model.attributes).filter(([_, attr]) => (0, models_1.isRelationAttribute)(attr));
        await Promise.all(relationAttributes.map(async ([fieldName, attr]) => {
            const value = data[fieldName];
            if (value !== undefined && value !== null) {
                await validateRelation(attr, value, path, errors, fieldName, importData);
            }
        }));
    }
    // Recursively validate components and dynamic zones content
    await validateComponentContent(data, model, path, errors, ignoreMissingRelations, importData);
}
async function validateRelation(attr, value, path, errors, attrName, importData) {
    const targetModel = (0, models_1.getModel)(attr.target);
    const targetIdField = (0, identifiers_1.getIdentifierField)(targetModel);
    async function checkRelationExists(id) {
        const publishedVersion = await strapi.documents(attr.target).findFirst({
            filters: { [targetIdField]: id },
            status: 'published',
        });
        const draftVersion = await strapi.documents(attr.target).findFirst({
            filters: { [targetIdField]: id },
            status: 'draft',
        });
        if (publishedVersion &&
            draftVersion &&
            publishedVersion.documentId !== draftVersion.documentId) {
            errors.push(createValidationError(`Found conflicting published and draft versions for relation ${attr.target} with ${targetIdField}='${id}'`, [...path, attrName], value));
            return;
        }
        const exists = publishedVersion || draftVersion;
        if (!exists && (!importData || !checkImportData(id))) {
            errors.push(createValidationError(`Related entity with ${targetIdField}='${id}' not found in ${attr.target} (checked both published and draft)`, [...path, attrName], value));
        }
    }
    function checkImportData(id) {
        const targetEntries = importData[attr.target] || [];
        return targetEntries.some((entry) => {
            if (entry.published) {
                const publishedMatch = Object.values(entry.published).some((localeData) => localeData[targetIdField] === id);
                if (publishedMatch)
                    return true;
            }
            if (entry.draft) {
                return Object.values(entry.draft).some((localeData) => localeData[targetIdField] === id);
            }
            return false;
        });
    }
    if (Array.isArray(value)) {
        await Promise.all(value.map((id) => checkRelationExists(id)));
    }
    else {
        await checkRelationExists(value);
    }
}
// Update validateComponentContent to pass through ignoreMissingRelations
async function validateComponentContent(data, model, path, errors, ignoreMissingRelations, importData) {
    if (!data || typeof data !== 'object')
        return;
    for (const [fieldName, attr] of Object.entries(model.attributes)) {
        const value = data[fieldName];
        if (!value)
            continue;
        if ((0, models_1.isComponentAttribute)(attr)) {
            const componentModel = (0, models_1.getModel)(attr.component);
            if (Array.isArray(value)) {
                await Promise.all(value.map((item, index) => validateContent(item, componentModel, [...path, fieldName, index.toString()], errors, ignoreMissingRelations, importData)));
            }
            else {
                await validateContent(value, componentModel, [...path, fieldName], errors, ignoreMissingRelations, importData);
            }
        }
        else if ((0, models_1.isDynamicZoneAttribute)(attr)) {
            if (Array.isArray(value)) {
                await Promise.all(value.map(async (item, index) => {
                    if (item && item.__component) {
                        const componentModel = (0, models_1.getModel)(item.__component);
                        if (componentModel) {
                            await validateContent(item, componentModel, [...path, fieldName, index.toString()], errors, ignoreMissingRelations, importData);
                        }
                    }
                }));
            }
        }
    }
}
// Validates constraints (uniqueness)
async function validateConstraints(data, model, path, errors, existingAction) {
    await validateUniqueFields(model.uid, [{ published: { default: data } }], errors, existingAction);
}
function attributeIsUnique(attribute) {
    return 'unique' in attribute;
}
function validateModelConfiguration(model) {
    // const idField = getIdentifierField(model);
    // const attribute: Schema.Attribute.AnyAttribute = model.attributes[idField];
    // if (!attribute) {
    //     throw new Error(`IdField not found in model: Field '${idField}' is missing from model '${model.uid}'`);
    // }
    // if (!attributeIsUnique(attribute)) {
    //     throw new Error(
    //         `IdField type not supported in model: Field '${idField}' in model '${model.uid}' must have a unique option. ` +
    //         `Current settings - type: ${attribute.type}`
    //     );
    // }
    // if (attributeIsUnique(attribute) && (!attribute.required || !attribute.unique)) {
    //     throw new Error(
    //         `IdField misconfigured in model: Field '${idField}' in model '${model.uid}' must be both required and unique. ` +
    //         `Current settings - required: ${!!attribute.required}, unique: ${!!attribute.unique}`
    //     );
    // }
    if (model.kind !== 'singleType') {
        (0, validation_1.validateIdField)(model);
    }
}
function validateMediaField(value, path, errors) {
    const isValidUrl = (url) => url.startsWith('http://') || url.startsWith('https://');
    if (Array.isArray(value)) {
        value.forEach((item, index) => validateMediaField(item, [...path, index.toString()], errors));
        return;
    }
    if (typeof value === 'string') {
        if (!isValidUrl(value)) {
            errors.push(createValidationError('Media URL must be absolute', path, value));
        }
        return;
    }
    if (typeof value === 'object' && value !== null) {
        const hasIdentifier = value.url || value.hash || value.name;
        if (!hasIdentifier) {
            errors.push(createValidationError('Media object must contain either url, hash, or name', path, value));
            return;
        }
        if (value.url && !value.hash && !value.name && !isValidUrl(value.url)) {
            errors.push(createValidationError('Media URL must be absolute when used as the only identifier', path, value));
        }
        return;
    }
    errors.push(createValidationError(`Invalid media value type: ${typeof value}`, path, value));
}
function validateUnknownFields(data, model, path, errors, isDynamicZoneComponent = false) {
    if (!data || typeof data !== 'object')
        return;
    const validAttributeNames = new Set(Object.keys(model.attributes));
    const ignoredFields = isDynamicZoneComponent ? new Set(['__component']) : new Set();
    if (isDynamicZoneComponent) {
        console.log('isDynamicZoneComponent', isDynamicZoneComponent);
        console.log('Attributes', JSON.stringify(model, null, 2));
    }
    // Check top-level unknown fields
    for (const key of Object.keys(data)) {
        if (!validAttributeNames.has(key) && !ignoredFields.has(key)) {
            errors.push(createValidationError(`Unknown field '${key}' found in data. This field does not exist in the model.`, [...path, key], data[key]));
        }
    }
    // Recursively check components and dynamic zones
    for (const [key, attr] of Object.entries(model.attributes)) {
        if (!data[key])
            continue;
        if ((0, models_1.isComponentAttribute)(attr)) {
            const componentModel = (0, models_1.getModel)(attr.component);
            if (Array.isArray(data[key])) {
                data[key].forEach((item, index) => {
                    validateUnknownFields(item, componentModel, [...path, key, index.toString()], errors, false);
                });
            }
            else {
                validateUnknownFields(data[key], componentModel, [...path, key], errors, false);
            }
        }
        else if ((0, models_1.isDynamicZoneAttribute)(attr)) {
            if (Array.isArray(data[key])) {
                data[key].forEach((item, index) => {
                    if (item.__component) {
                        const componentModel = (0, models_1.getModel)(item.__component);
                        if (componentModel) {
                            validateUnknownFields(item, componentModel, [...path, key, index.toString()], errors, true);
                        }
                    }
                });
            }
        }
    }
}
function validateMediaFields(data, model, path, errors) {
    if (!data || typeof data !== 'object')
        return;
    for (const [fieldName, attr] of Object.entries(model.attributes)) {
        if (data[fieldName] !== undefined && data[fieldName] !== null && attr.type === 'media') {
            validateMediaField(data[fieldName], [...path, fieldName], errors);
        }
    }
}
async function validateRequiredRelation(attr, value, path, errors, attrName) {
    const targetModel = (0, models_1.getModel)(attr.target);
    const targetIdField = (0, identifiers_1.getIdentifierField)(targetModel);
    if (Array.isArray(value)) {
        for (const id of value) {
            const exists = await strapi.documents(attr.target).findFirst({
                filters: { [targetIdField]: id },
            });
            if (!exists) {
                errors.push({
                    message: `Related entity with ${targetIdField}='${id}' not found in ${attr.target}`,
                    path: [...path, attrName],
                    entry: value,
                });
            }
        }
    }
    else {
        const exists = await strapi.documents(attr.target).findFirst({
            filters: { [targetIdField]: value },
        });
        if (!exists) {
            errors.push({
                message: `Related entity with ${targetIdField}='${value}' not found in ${attr.target}`,
                path: [...path, attrName],
                entry: value,
            });
        }
    }
}
async function validateUniqueFields(contentType, entries, errors, existingAction = import_v3_1.ExistingAction.Warn) {
    const model = (0, models_1.getModel)(contentType);
    const uniqueAttributes = Object.entries(model.attributes).filter(([_, attr]) => attributeIsUnique(attr) && attr.unique);
    const idField = (0, identifiers_1.getIdentifierField)(model);
    // Track values we've seen in this import
    const seenValues = {};
    uniqueAttributes.forEach(([name]) => (seenValues[name] = new Set()));
    for (const entry of entries) {
        // Only check published versions for uniqueness
        if (!entry.published)
            continue;
        for (const [locale, data] of Object.entries(entry.published)) {
            for (const [attrName, attr] of uniqueAttributes) {
                const value = data[attrName];
                if (value === undefined || value === null)
                    continue;
                // Check if we've seen this value in our import data
                if (seenValues[attrName].has(value)) {
                    errors.push({
                        message: `Duplicate value '${value}' for unique field '${attrName}'`,
                        path: ['published', locale, attrName],
                        entry: data,
                    });
                    continue;
                }
                seenValues[attrName].add(value);
                // Check if this value exists in the database
                const existing = await strapi.documents(contentType).findFirst({
                    filters: { [attrName]: value },
                });
                if (existing) {
                    console.log('Existing record:', existingAction, existing[idField], data[idField]);
                    if (existing[idField] === data[idField]) {
                        switch (existingAction) {
                            case import_v3_1.ExistingAction.Skip:
                                console.log(`Found existing record with ${attrName}=${value}, will skip during import`);
                                continue;
                            case import_v3_1.ExistingAction.Update:
                                console.log(`Found existing record with ${attrName}=${value}, will update during import`);
                                continue;
                            case import_v3_1.ExistingAction.Warn:
                            default:
                                errors.push({
                                    message: `Value '${value}' for unique field '${attrName}' already exists in database`,
                                    path: ['published', locale, attrName],
                                    entry: data,
                                });
                        }
                    }
                    else {
                        // If it's a different record with the same unique value, always error
                        errors.push({
                            message: `Value '${value}' for unique field '${attrName}' already exists in database on a different record`,
                            path: ['published', locale, attrName],
                            entry: data,
                        });
                    }
                }
            }
        }
    }
}
