import { Schema, Struct, UID } from '@strapi/types';
import { toArray } from '../../libs/arrays.js';

export function getAllSlugs({ includePluginsContentTypes = false } = {}) {
  return Array.from(strapi.db.metadata)
    .filter(
      ([collectionName]) =>
        collectionName.startsWith('api::') ||
        (includePluginsContentTypes && collectionName.startsWith('plugin::'))
    )
    .map(([collectionName]) => collectionName);
}

export function getModel(slug) {
  return strapi.getModel(slug) as Struct.ContentTypeSchema;
}

export function getModelFromSlugOrModel(modelOrSlug) {
  let model = modelOrSlug;
  if (typeof model === 'string') {
    model = getModel(modelOrSlug);
  }

  return model;
}

/**
 * Get the attributes of a model.
 */
export function getModelAttributes(
  slug,
  options: {
    filterType?: Schema.Attribute.Kind[];
    filterOutType?: Schema.Attribute.Kind[];
    filterOutTarget?: Struct.ContentTypeSchema;
  } = {}
) {
  const schema = getModel(slug);
  if (!schema) {
    return [];
  }

  // console.log(slug, JSON.stringify(schema.attributes));

  const typesToKeep = options.filterType ? toArray(options.filterType) : [];
  const typesToFilterOut = options.filterOutType ? toArray(options.filterOutType) : [];
  const targetsToFilterOut = toArray(options.filterOutTarget || []);

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

export function isComponentAttribute(attribute): attribute is Schema.Attribute.Component {
  return attribute.type === 'component';
}

export function isDynamicZoneAttribute(attribute): attribute is Schema.Attribute.DynamicZone {
  return attribute.type === 'dynamiczone';
}

export function isMediaAttribute(attribute): attribute is Schema.Attribute.Media {
  return attribute.type === 'media';
}

export function isRelationAttribute(attribute): attribute is Schema.Attribute.RelationWithTarget {
  return attribute.type === 'relation';
}

export function getEntryProp(entry, prop) {
  return entry[prop];
}

export function setEntryProp(entry, prop, value) {
  entry[prop] = value;
}

export function deleteEntryProp(entry, prop) {
  delete entry[prop];
}
