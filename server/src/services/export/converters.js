import { isArraySafe, toArray } from '../../../libs/arrays.js';
import { isObjectSafe } from '../../../libs/objects.js';
import { CustomSlugToSlug, CustomSlugs } from '../../config/constants.js';
import { getConfig } from '../../utils/getConfig.js';
import { getModelAttributes, getModel } from '../../utils/models';

const convertToCsv = (entries, options) => {
  entries = toArray(entries);
  const columnTitles = ['id'].concat(
    getModelAttributes(options.slug, { filterOutTarget: ['admin::user'] }).map((attr) => attr.name)
  );
  const content = [convertStrArrayToCsv(columnTitles)]
    .concat(
      entries.map((entry) => convertEntryToStrArray(entry, columnTitles)).map(convertStrArrayToCsv)
    )
    .join('\r\n');
  return content;
};

const convertStrArrayToCsv = (entry) => {
  return entry
    .map(stringifyEntry)
    .map((v) => v.replace(/"/g, '""'))
    .map((v) => `"${v}"`)
    .join(',');
};

const stringifyEntry = (entry) => {
  if (typeof entry === 'object') {
    return JSON.stringify(entry);
  }

  return String(entry);
};

const convertEntryToStrArray = (entry, keys) => {
  return keys.map((key) => entry[key]);
};

const convertToJson = (entries, options) => {
  entries = JSON.stringify(entries, null, '\t');
  return entries;
};

const withBeforeConvert = (convertFn) => (entries, options) => {
  entries = beforeConvert(entries, options);
  entries = convertFn(entries, options);
  return entries;
};

const beforeConvert = (entries, options) => {
  entries = toArray(entries);

  entries = exportMedia(entries, options);
  if (options.relationsAsId) {
    entries = exportRelationsAsId(entries, options);
  }

  if (getModel(options.slug).kind === 'singleType') {
    return entries?.[0];
  }
  return entries;
};

const exportMedia = (entries, options) => {
  if (options.slug === CustomSlugToSlug[CustomSlugs.MEDIA]) {
    entries = entries.map((entry) => {
      if (isObjectSafe(entry) && entry.url.startsWith('/')) {
        entry.url = computeUrl(entry.url);
      }
      return entry;
    });

    return entries;
  }

  const mediaKeys = getModelAttributes(options.slug, {
    filterOutTarget: ['admin::user'],
    filterType: ['media'],
  }).map((attr) => attr.name);
  const relationsAttr = getModelAttributes(options.slug, {
    filterOutTarget: ['admin::user'],
    filterType: ['component', 'dynamiczone', 'relation'],
  });

  entries = entries.map((entry) => {
    mediaKeys.forEach((key) => {
      if (isArraySafe(entry[key])) {
        entry[key] = entry[key].map((entryItem) => {
          if (isObjectSafe(entryItem) && entryItem.url.startsWith('/')) {
            entryItem.url = computeUrl(entryItem.url);
          }
          return entryItem;
        });
      } else if (isObjectSafe(entry[key]) && entry[key].url.startsWith('/')) {
        entry[key].url = computeUrl(entry[key].url);
      }
    });

    relationsAttr.forEach((attr) => {
      if (attr.type === 'component') {
        if (entry[attr.name]) {
          const areMultiple = attr.repeatable;
          const relEntriesProcessed = exportMedia(toArray(entry[attr.name]), {
            slug: attr.component,
          });
          entry[attr.name] = areMultiple ? relEntriesProcessed : relEntriesProcessed?.[0] || null;
        }
      } else if (attr.type === 'dynamiczone') {
        if (entry[attr.name]) {
          entry[attr.name] = entry[attr.name].map(
            (component) => exportMedia([component], { slug: component.__component })?.[0] || null
          );
        }
      } else if (attr.type === 'relation') {
        if (entry[attr.name]) {
          const areMultiple = isArraySafe(entry[attr.name]);
          const relEntriesProcessed = exportMedia(toArray(entry[attr.name]), { slug: attr.target });
          entry[attr.name] = areMultiple ? relEntriesProcessed : relEntriesProcessed?.[0] || null;
        }
      }
    });

    return entry;
  });

  return entries;
};

const computeUrl = (relativeUrl) => {
  return getConfig('serverPublicHostname') + relativeUrl;
};

const exportRelationsAsId = (entries, options) => {
  const relationKeys = getModelAttributes(options.slug, {
    filterOutTarget: ['admin::user'],
    filterType: ['component', 'dynamiczone', 'media', 'relation'],
  }).map((attr) => attr);

  return entries.map((entry) => {
    relationKeys.forEach((key) => {
      const relationName = key.name;

      if (entry[relationName] == null) {
        entry[relationName] = null;
      } else if (isArraySafe(entry[relationName])) {
        entry[relationName] = entry[relationName].map((rel) => {
          if (key.type === 'component') {
            console.log(relationName, JSON.stringify(rel));
            return exportRelationsAsId(toArray(rel), { slug: key.component });
          } else {
            if (typeof rel === 'object') {
              return rel.id;
            }
            return rel;
          }
        });
      } else if (isObjectSafe(entry[relationName])) {
        entry[relationName] = entry[relationName].id;
      }
    });

    return entry;
  });
};

const convertToCsvWithBeforeConvert = withBeforeConvert(convertToCsv);
const convertToJsonWithBeforeConvert = withBeforeConvert(convertToJson);

export {
  convertToCsvWithBeforeConvert as convertToCsv,
  convertToJsonWithBeforeConvert as convertToJson,
};
