"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateIdField = validateIdField;
const identifiers_1 = require("../../utils/identifiers");
function validateIdField(model) {
    // console.log('validateIdField', model);
    const idField = (0, identifiers_1.getIdentifierField)(model);
    const attribute = model.attributes[idField];
    if (!attribute) {
        throw new Error(`IdField not found in model: Field '${idField}' is missing from model '${model.uid}'`);
    }
    if (!(0, identifiers_1.attributeIsUnique)(attribute) && attribute.type !== 'uid') {
        throw new Error(`IdField type not supported in model: Field '${idField}' in model '${model.uid}' must have a unique option. ` +
            `Current settings - type: ${attribute.type}`);
    }
    if (((0, identifiers_1.attributeIsUnique)(attribute) && (!attribute.required || !attribute.unique)) ||
        (attribute.type === 'uid' && !attribute.required)) {
        throw new Error(`IdField misconfigured in model: Field '${idField}' in model '${model.uid}' must be ${attribute.type === 'uid' ? 'required' : 'both required and unique'}. ` +
            `Current settings - required: ${!!attribute.required}${attribute.type !== 'uid' ? `, unique: ${!!attribute.unique}` : 'true'}`);
    }
    return idField;
}
