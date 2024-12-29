import { Schema, UID } from '@strapi/types';
import { getModel, isComponentAttribute, isDynamicZoneAttribute, isRelationAttribute } from '../../utils/models';
import { getIdentifierField } from '../export/export-v3';
import { EntryVersion, LocaleVersions } from './import-v3';

interface ValidationError {
  message: string;
  path?: string[];
  entry?: any;
}

interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

interface FileContent {
  version: number;
  data: Record<UID.ContentType, EntryVersion[]>;
}

async function validateFileContent(
  fileContent: FileContent,
  options: { updateExisting?: boolean } = {}
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];

  // Basic file structure validation
  if (!fileContent.version || fileContent.version !== 3) {
    return {
      isValid: false,
      errors: [{ message: 'Invalid file version. Expected version 3.' }]
    };
  }

  if (!fileContent.data || typeof fileContent.data !== 'object') {
    return {
      isValid: false,
      errors: [{ message: 'Invalid file structure. Expected data object.' }]
    };
  }

  // Validate each content type
  for (const [contentType, entries] of Object.entries(fileContent.data)) {
    try {
      const model = getModel(contentType as UID.ContentType);
      if (!model) {
        errors.push({ 
          message: `Model ${contentType} not found`,
          path: [contentType]
        });
        continue;
      }

      // Validate model configuration
      try {
        validateModelConfiguration(model);
      } catch (error) {
        errors.push({ 
          message: error.message,
          path: [contentType]
        });
        continue;
      }

      // First pass: Check required fields and relations
      await validateRequiredFields(contentType as UID.ContentType, entries, errors, [contentType]);

      // Second pass: Check uniqueness constraints
      await validateUniqueFields(contentType as UID.ContentType, entries, errors, options.updateExisting);

    } catch (error) {
      errors.push({ 
        message: `Validation failed for ${contentType}: ${error.message}`,
        path: [contentType]
      });
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

function attributeIsUnique(attribute: Schema.Attribute.AnyAttribute): attribute is Schema.Attribute.AnyAttribute & Schema.Attribute.UniqueOption {
  return 'unique' in attribute;
}

function validateModelConfiguration(model: Schema.Schema) {
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
}

async function validateRequiredFields(
  contentType: UID.ContentType,
  entries: EntryVersion[],
  errors: ValidationError[],
  path: string[] = []
): Promise<void> {
  console.log('\n=== Starting validateRequiredFields ===');
  console.log('ContentType:', contentType);
  console.log('Path:', path);
  
  const model = getModel(contentType);
  console.log('Model:', {
    uid: model.uid,
    attributes: Object.keys(model.attributes)
  });
  
  // Get all attributes, not just required ones
  const attributes = Object.entries(model.attributes);
  console.log('\nAll attributes:', attributes.map(([name, attr]) => ({
    name,
    type: attr.type,
    required: attr.required
  })));

  // Filter required attributes for basic field validation
  const requiredAttributes = attributes.filter(([_, attr]) => attr.required);
  console.log('\nRequired attributes:', requiredAttributes.map(([name, attr]) => ({
    name,
    type: attr.type
  })));

  // Get all component attributes that have values (even if not required)
  const componentAttributes = attributes.filter(([_, attr]) => 
    isComponentAttribute(attr) || isDynamicZoneAttribute(attr)
  );
  console.log('\nComponent attributes:', componentAttributes.map(([name, attr]) => ({
    name,
    type: attr.type,
    required: attr.required
  })));

  for (const entry of entries) {
    console.log('\nProcessing entry:', JSON.stringify(entry, null, 2));
    
    for (const [version, localeVersions] of Object.entries(entry) as [keyof EntryVersion, LocaleVersions][]) {
      console.log('\nProcessing version:', version);
      
      for (const [locale, data] of Object.entries(localeVersions)) {
        console.log('\nProcessing locale:', locale);
        console.log('Data:', JSON.stringify(data, null, 2));
        
        const currentPath = [...path, version, locale];
        console.log('Current path:', currentPath);

        // Check required fields
        console.log('\nChecking required fields...');
        for (const [attrName, attr] of requiredAttributes) {
          console.log(`\nChecking required attribute: ${attrName}`, {
            type: attr.type,
            value: data[attrName]
          });
          
          const value = data[attrName];
          
          if (value === undefined || value === null) {
            console.log(`Missing required value for ${attrName}`);
            errors.push({
              message: `Required field '${attrName}' is missing`,
              path: [...currentPath, attrName],
              entry: data
            });
            continue;
          }

          if (isRelationAttribute(attr)) {
            console.log(`Validating required relation: ${attrName}`);
            await validateRequiredRelation(attr, value, currentPath, errors, attrName);
          }
        }

        // Check all components and dynamic zones that have values
        console.log('\nChecking components and dynamic zones...');
        for (const [attrName, attr] of componentAttributes) {
          console.log(`\nChecking component attribute: ${attrName}`, {
            type: attr.type,
            required: attr.required,
            hasValue: data[attrName] !== undefined && data[attrName] !== null
          });
          
          const value = data[attrName];
          if (value === undefined || value === null) {
            console.log(`Skipping ${attrName} - no value present`);
            continue;
          }

          if (isComponentAttribute(attr)) {
            console.log(`Validating component: ${attrName}`);
            await validateRequiredComponent(attr, value, currentPath, errors, attrName);
          } else if (isDynamicZoneAttribute(attr)) {
            console.log(`Validating dynamic zone: ${attrName}`);
            await validateRequiredDynamicZone(attr, value, currentPath, errors, attrName);
          }
        }
      }
    }
  }
  console.log('\n=== Finished validateRequiredFields ===\n');
}

async function validateRequiredRelation(
  attr: Schema.Attribute.RelationWithTarget,
  value: any,
  path: string[],
  errors: ValidationError[],
  attrName: string
) {
  const targetModel = getModel(attr.target);
  const targetIdField = getIdentifierField(targetModel);

  if (Array.isArray(value)) {
    for (const id of value) {
      const exists = await strapi.documents(attr.target).findFirst({
        filters: { [targetIdField]: id }
      });
      if (!exists) {
        errors.push({
          message: `Related entity with ${targetIdField}='${id}' not found in ${attr.target}`,
          path: [...path, attrName],
          entry: value
        });
      }
    }
  } else {
    const exists = await strapi.documents(attr.target).findFirst({
      filters: { [targetIdField]: value }
    });
    if (!exists) {
      errors.push({
        message: `Related entity with ${targetIdField}='${value}' not found in ${attr.target}`,
        path: [...path, attrName],
        entry: value
      });
    }
  }
}

async function validateRequiredComponent(
  attr: Schema.Attribute.Component,
  value: any,
  path: string[],
  errors: ValidationError[],
  attrName: string
) {
  console.log('\nValidating component:', {
    componentUid: attr.component,
    attrName,
    path,
    value: JSON.stringify(value, null, 2)
  });

  const componentModel = getModel(attr.component);
  console.log('Component model:', {
    uid: componentModel.uid,
    attributes: Object.keys(componentModel.attributes)
  });

  const requiredAttributes = Object.entries(componentModel.attributes)
    .filter(([_, attr]) => attr.required);
  console.log('Required attributes:', requiredAttributes.map(([name]) => name));

  if (attr.repeatable && Array.isArray(value)) {
    console.log('Processing repeatable component with', value.length, 'items');
    for (const [index, item] of value.entries()) {
      console.log(`\nValidating repeatable item ${index}:`, JSON.stringify(item, null, 2));
      const itemPath = [...path, attrName, index.toString()];
      await validateComponentData(item, componentModel, requiredAttributes, errors, itemPath);
    }
  } else {
    console.log('Processing single component');
    await validateComponentData(value, componentModel, requiredAttributes, errors, [...path, attrName]);
  }
}

async function validateComponentData(
  data: any,
  componentModel: Schema.Schema,
  requiredAttributes: [string, Schema.Attribute.AnyAttribute][],
  errors: ValidationError[],
  path: string[]
) {
  console.log('\nValidating component data:', {
    componentUid: componentModel.uid,
    path,
    data: JSON.stringify(data, null, 2)
  });

  // Get all attributes of the component
  const attributes = Object.entries(componentModel.attributes);
  console.log('\nAll component attributes:', attributes.map(([name, attr]) => ({
    name,
    type: attr.type,
    required: attr.required
  })));

  // Get all component attributes regardless of required status
  const componentAttributes = attributes.filter(([_, attr]) => 
    isComponentAttribute(attr) || isDynamicZoneAttribute(attr)
  );
  console.log('\nNested component attributes:', componentAttributes.map(([name, attr]) => ({
    name,
    type: attr.type,
    required: attr.required
  })));

  // First check required fields
  console.log('\nChecking required fields in component...');
  for (const [fieldName, attr] of requiredAttributes) {
    console.log(`\nChecking required field '${fieldName}'`, {
      attributeType: attr.type,
      value: data[fieldName]
    });
    
    const value = data[fieldName];
    
    if (value === undefined || value === null) {
      console.log(`Missing required field '${fieldName}'`);
      errors.push({
        message: `Required field '${fieldName}' is missing in component '${componentModel.uid}'`,
        path: [...path, fieldName],
        entry: data
      });
      continue;
    }

    if (isRelationAttribute(attr)) {
      console.log(`Validating relation field '${fieldName}'`);
      await validateRequiredRelation(attr, value, path, errors, fieldName);
    }
  }

  // Then check all components and dynamic zones that have values
  console.log('\nChecking nested components and dynamic zones...');
  for (const [fieldName, attr] of componentAttributes) {
    console.log(`\nChecking nested component field: ${fieldName}`, {
      type: attr.type,
      required: attr.required,
      hasValue: data[fieldName] !== undefined && data[fieldName] !== null
    });
    
    const value = data[fieldName];
    if (value === undefined || value === null) {
      console.log(`Skipping ${fieldName} - no value present`);
      continue;
    }

    if (isComponentAttribute(attr)) {
      console.log(`Validating nested component: ${fieldName}`);
      await validateRequiredComponent(attr, value, path, errors, fieldName);
    } else if (isDynamicZoneAttribute(attr)) {
      console.log(`Validating nested dynamic zone: ${fieldName}`);
      await validateRequiredDynamicZone(attr, value, path, errors, fieldName);
    }
  }
}

async function validateRequiredDynamicZone(
  attr: Schema.Attribute.DynamicZone,
  value: any[],
  path: string[],
  errors: ValidationError[],
  attrName: string
) {
  if (!Array.isArray(value)) {
    errors.push({
      message: `Dynamic zone must be an array`,
      path: [...path, attrName],
      entry: value
    });
    return;
  }

  for (const item of value) {
    if (!item.__component) {
      errors.push({
        message: `Dynamic zone item missing __component field`,
        path: [...path, attrName],
        entry: item
      });
      continue;
    }

    const componentModel = getModel(item.__component);
    await validateRequiredFields(item.__component, [{ published: { default: item } }], errors, [...path, attrName]);
  }
}

async function validateUniqueFields(
  contentType: UID.ContentType,
  entries: EntryVersion[],
  errors: ValidationError[],
  updateExisting: boolean = false
) {
  const model = getModel(contentType);
  const uniqueAttributes = Object.entries(model.attributes)
    .filter(([_, attr]) => attributeIsUnique(attr) && attr.unique);
  const idField = getIdentifierField(model);

  // Track values we've seen in this import
  const seenValues: Record<string, Set<any>> = {};
  uniqueAttributes.forEach(([name]) => seenValues[name] = new Set());

  for (const entry of entries) {
    // Only check published versions for uniqueness
    if (!entry.published) continue;

    for (const [locale, data] of Object.entries(entry.published)) {
      for (const [attrName, attr] of uniqueAttributes) {
        const value = data[attrName];
        if (value === undefined || value === null) continue;

        // Check if we've seen this value in our import data
        if (seenValues[attrName].has(value)) {
          errors.push({
            message: `Duplicate value '${value}' for unique field '${attrName}'`,
            path: ['published', locale, attrName],
            entry: data
          });
          continue;
        }
        seenValues[attrName].add(value);

        // Check if this value exists in the database
        const existing = await strapi.documents(contentType).findFirst({
          filters: { [attrName]: value }
        });

        if (existing) {
          // If we're allowing updates and this is the same record (matching idField), it's okay
          if (updateExisting && existing[idField] === data[idField]) {
            console.log(`Found existing record with ${attrName}=${value}, but matches idField=${data[idField]} - allowing update`);
            continue;
          }

          errors.push({
            message: `Value '${value}' for unique field '${attrName}' already exists in database`,
            path: ['published', locale, attrName],
            entry: data
          });
        }
      }
    }
  }
}

export {
  validateFileContent,
  type ValidationResult,
  type ValidationError,
  type FileContent
}; 