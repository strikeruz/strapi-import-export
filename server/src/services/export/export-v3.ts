import { getModel, getModelAttributes, isComponentAttribute, isDynamicZoneAttribute, isMediaAttribute, isRelationAttribute, getAllSlugs } from '../../utils/models';
import { CustomSlugs, CustomSlugToSlug } from '../../config/constants.js';
import { buildPopulateForModel } from './buildPopulate.js';
import { getConfig } from '../../utils/getConfig.js';

import { Struct, Schema, UID } from '@strapi/types';

/**
 * 
 * Get the identifier field for a model, falling back through uid -> name -> title -> id
 */
function getIdentifierField(model) {
  console.log('getIdentifierField for model:', model.uid);
  if (model.pluginOptions?.['import-export-entries']?.idField) {
    console.log('Using configured idField:', model.pluginOptions['import-export-entries'].idField);
    return model.pluginOptions['import-export-entries'].idField;
  }
  
  const attributes = model.attributes || {};
  console.log('Looking for identifier in attributes:', Object.keys(attributes));
  if (attributes.uid) return 'uid';
  if (attributes.name) return 'name';
  if (attributes.title) return 'title';
  console.log('Falling back to id');
  return 'id';
}

/**
 * Compute the absolute URL from a relative URL
 */
const computeUrl = (relativeUrl) => {
  return getConfig('serverPublicHostname') + relativeUrl;
};

/**
 * Recursively process any data object according to its schema
 */
function processDataWithSchema(data, schema: Schema.Schema, options = { processLocalizations: true }) {
  console.log(`Processing data for schema: ${schema.uid}`);
  console.log('Raw data:', JSON.stringify(data, null, 2));
  if (!data) return null;

  const processed = { ...data };
  
  // Only delete id if it's not being used as the identifier field
  const idField = getIdentifierField(schema);
  console.log('Identifier field:', idField, 'schema:', schema.uid, 'id:', processed.id);
  if (idField !== 'id') {
    delete processed.id;
  }
  
  delete processed.documentId;

  if (!options.processLocalizations) {
    delete processed.localizations;
  }
  

  for (const [key, attr] of Object.entries(schema.attributes)) {
    console.log(`Processing attribute ${key} of type ${attr.type}`);
    console.log(`Current value:`, JSON.stringify(data[key], null, 2));
    
    if (data[key] === undefined || data[key] === null) {
      console.log(`No data for ${key}, skipping`);
      continue;
    }

    // Special handling for localizations
    if (key === 'localizations' && options.processLocalizations) {
      console.log('Processing localizations');
      processed[key] = data[key]?.map(localization => 
        // Process each localization but prevent recursive localization processing
        ({...(processDataWithSchema(localization, schema, { processLocalizations: false })), documentId: localization.documentId})
      ) || [];
      continue;
    }

    if (isRelationAttribute(attr)) {
      const relatedModel = getModel((attr as Schema.Attribute.RelationWithTarget).target);
      const relatedIdField = getIdentifierField(relatedModel);
      console.log(`Relation ${key} uses identifier field ${relatedIdField}`);
      
      if (attr.relation.endsWith('Many')) {
        processed[key] = data[key]?.map(item => {
          console.log('Processing relation item:', item);
          return item[relatedIdField];
        }) || [];
      } else {
        console.log('Processing single relation:', data[key]);
        processed[key] = data[key]?.[relatedIdField] || null;
      }
    } else if (isComponentAttribute(attr)) {
      const componentModel = getModel(attr.component);
      console.log(`Processing component ${key} with model ${componentModel.uid}`);
      
      if (attr.repeatable) {
        processed[key] = data[key]?.map(item => 
          processDataWithSchema(item, componentModel)
        ) || [];
      } else {
        processed[key] = processDataWithSchema(data[key], componentModel);
      }
    } else if (isDynamicZoneAttribute(attr)) {
      console.log(`Processing dynamic zone ${key}`);
      processed[key] = data[key]?.map(item => {
        const componentModel = getModel(item.__component);
        return {
          __component: item.__component,
          ...processDataWithSchema(item, componentModel)
        };
      }) || [];
    } else if (isMediaAttribute(attr)) {
      console.log(`Processing media ${key}`);
      if (attr.multiple) {
        processed[key] = data[key]?.map(media => ({
          url: media.url.startsWith('/') ? computeUrl(media.url) : media.url,
          name: media.name,
          caption: media.caption,
          hash: media.hash,
          alternativeText: media.alternativeText,
          createdAt: media.createdAt,
          updatedAt: media.updatedAt,
          publishedAt: media.publishedAt,
        })) || [];
      } else {
        processed[key] = data[key] ? {
          url: data[key].url.startsWith('/') ? computeUrl(data[key].url) : data[key].url,
          name: data[key].name,
          caption: data[key].caption,
          hash: data[key].hash,
          alternativeText: data[key].alternativeText,
          createdAt: data[key].createdAt,
          updatedAt: data[key].updatedAt,
          publishedAt: data[key].publishedAt,
        } : null;
      }
    }
  }

  return processed;
}

/**
 * Group entry data by locale, comparing with published version to only include changed drafts
 */
function groupByLocale(entry, publishedEntry, model, exportAllLocales = true) {
  const result: {
    draft?: Record<string, any>;
    published?: Record<string, any>;
  } = {};
  
  // // Process main entry
  // const mainLocale = entry.locale;
  // // If no locale field exists or we're not exporting all locales, use 'default'
  // const localeKey = (!mainLocale || !exportAllLocales) ? 'default' : mainLocale;

  // Always remove localizations from the processed data
  const processEntry = (data) => {
    const processed = processDataWithSchema(data, model, { processLocalizations: true });
    delete processed.localizations;
    return processed;
  };

  // Compare draft and published versions for each locale
  const draftData = processEntry(entry);
  const publishedData = publishedEntry ? processEntry(publishedEntry) : null;

  // Only include draft if it's different from published
  if (!publishedData || !areVersionsEqual(draftData, publishedData)) {
    // result.draft = { [localeKey]: draftData };
    result.draft = { default: draftData };
  }

  // Process localizations only if we're exporting all locales and we have a real locale
  // if (mainLocale && exportAllLocales && entry.localizations?.length) {
  if (exportAllLocales && entry.localizations?.length) {
    for (const draftLoc of entry.localizations) {
      const locale = draftLoc.locale;
      if (!locale) continue;

      // Find corresponding published localization
      const publishedLoc = publishedEntry?.localizations?.find(l => l.locale === locale);
      
      const draftLocData = processEntry(draftLoc);
      const publishedLocData = publishedLoc ? processEntry(publishedLoc) : null;

      // Only include draft if it's different from published
      if (!publishedLocData || !areVersionsEqual(draftLocData, publishedLocData)) {
        if (!result.draft) result.draft = {};
        result.draft[locale] = draftLocData;
      }
    }
  }

  // Add published versions
  if (publishedEntry) {
    // result.published = { [localeKey]: processEntry(publishedEntry) };
    result.published = { default: processEntry(publishedEntry) };

    // Add published localizations only if we're exporting all locales and we have a real locale
    // if (mainLocale && exportAllLocales && publishedEntry.localizations?.length) {
    if (exportAllLocales && publishedEntry.localizations?.length) {
      for (const publishedLoc of publishedEntry.localizations) {
        const locale = publishedLoc.locale;
        if (!locale) continue;
        result.published[locale] = processEntry(publishedLoc);
      }
    }
  }

  return result;
}

/**
 * Compare two versions excluding specific fields
 */
function areVersionsEqual(version1, version2, excludeFields = ['publishedAt']) {
  const v1 = { ...version1 };
  const v2 = { ...version2 };
  
  excludeFields.forEach(field => {
    delete v1[field];
    delete v2[field];
  });
  
  return JSON.stringify(v1) === JSON.stringify(v2);
}

function validateIdField(model) {
  const idField = getIdentifierField(model);
  const attribute = model.attributes[idField];
  
  if (!attribute) {
    throw new Error(`IdField not found in model: Field '${idField}' is missing from model '${model.uid}'`);
  }

  // Check if the field is required and unique
  if (!attribute.required || !attribute.unique) {
    throw new Error(
      `IdField misconfigured in model: Field '${idField}' in model '${model.uid}' must be both required and unique. ` +
      `Current settings - required: ${!!attribute.required}, unique: ${!!attribute.unique}`
    );
  }





  return idField;
}

/**
 * Export data using v3 format
 */
async function exportDataV3({
  slug,
  search,
  applySearch,
  exportPluginsContentTypes,
  documentIds,
  exportAllLocales = true // Add new flag with default false for backward compatibility
}) {
  console.log('exportDataV3 called with:', { slug, search, applySearch, exportPluginsContentTypes, documentIds });
  
  const slugsToExport = 
    slug === CustomSlugs.WHOLE_DB ? 
    getAllSlugs({ includePluginsContentTypes: exportPluginsContentTypes }) : 
    [CustomSlugToSlug[slug] || slug];
  
  console.log('Slugs to export:', slugsToExport);

  const exportedData = {};
  
  for (const currentSlug of slugsToExport) {
    console.log(`\nProcessing slug: ${currentSlug}`);
    const model = getModel(currentSlug);
    if (!model || model.uid === 'admin::user') {
      console.log('Skipping model:', currentSlug);
      continue;
    }


    // Validate idField configuration
    validateIdField(model);


    

    // Build populate object for relations and components
    const populate = buildPopulateForModel(currentSlug);
    console.log('Using populate:', JSON.stringify(populate, null, 2));

    const documentIdFilter = documentIds?.length ? {
      documentId: { $in: documentIds }
    } : {};
  
    const searchParams = applySearch && search ? (
      typeof search === 'string' ? JSON.parse(search) : search
    ) : {};
  
    const filtersAndDocs = {
      filters: {
        ...searchParams.filters,
        ...documentIdFilter
      },
      ...(applySearch && searchParams.sort && { sort: searchParams.sort })
    };

    // First get all draft versions
    const draftEntries = await strapi.documents(currentSlug).findMany({
      populate: {
        ...populate,
        localizations: {
          populate: populate
        }
      },
      status: 'draft',
      ...filtersAndDocs
    });
    
    console.log(`Found ${draftEntries.length} draft entries`);
    
    exportedData[currentSlug] = [];

    // Process each draft entry and its corresponding published version
    for (const draftEntry of draftEntries) {
      console.log(`\nProcessing entry ${draftEntry.id}`);
      
      // Get the published version using the same documentId
      const publishedEntry = await strapi.documents(currentSlug).findOne({
        documentId: draftEntry.documentId,
        status: 'published',
        populate: {
          ...populate,
          ...(exportAllLocales && { // Only include localizations if we're exporting all locales
            localizations: {
              populate: populate
            }
          })
        }
      });

      const versions = groupByLocale(draftEntry, publishedEntry, model, exportAllLocales);
      
      // Only add the entry if there are actual differences
      if (versions.draft || versions.published) {
        exportedData[currentSlug].push(versions);
      }
    }
  }

  console.log('Export complete');
  return JSON.stringify({
    version: 3,
    data: exportedData
  }, null, '\t');
}

export {
  exportDataV3,
  getIdentifierField,
  processDataWithSchema
}; 