import { Schema } from '@strapi/types';
import { attributeIsUnique, getIdentifierField } from '../../utils/identifiers';

export function validateIdField(model: Schema.Schema) {
    const idField = getIdentifierField(model);
    const attribute: Schema.Attribute.AnyAttribute = model.attributes[idField];

    if (!attribute) {
        throw new Error(`IdField not found in model: Field '${idField}' is missing from model '${model.uid}'`);
    }

    if (!attributeIsUnique(attribute)) {
        throw new Error(
            `IdField type not supported in model: Field '${idField}' in model '${model.uid}' must have a unique option. ` +
            `Current settings - type: ${attribute.type}`
        );
    }

    if (attributeIsUnique(attribute) && (!attribute.required || !attribute.unique)) {
        throw new Error(
            `IdField misconfigured in model: Field '${idField}' in model '${model.uid}' must be both required and unique. ` +
            `Current settings - required: ${!!attribute.required}, unique: ${!!attribute.unique}`
        );
    }

    return idField;
}