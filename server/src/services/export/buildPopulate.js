import { getModelAttributes, getModel, isRelationAttribute, isComponentAttribute, isDynamicZoneAttribute, isMediaAttribute } from '../../utils/models';

export function buildPopulateForModel(slug, depth = 5) {
  console.log(`Building populate for ${slug} at depth ${depth}`);
  
  if (depth < 1) {
    console.log(`Max depth reached for ${slug}`);
    return true;
  }

  const model = getModel(slug);
  if (!model) {
    console.log(`No model found for ${slug}`);
    return true;
  }

  const populate = {};
  
  for (const [attrName, attrDef] of Object.entries(model.attributes)) {
    if (!attrDef) continue;

    if (isRelationAttribute(attrDef) || 
        isComponentAttribute(attrDef) || 
        isDynamicZoneAttribute(attrDef) || 
        isMediaAttribute(attrDef)) {
      
      console.log(`Found special attribute ${attrName} of type ${attrDef.type}`);
      
      if (isComponentAttribute(attrDef)) {
        console.log(`Building nested populate for component ${attrDef.component}`);
        // Get the component's model and build its populate object
        const componentModel = getModel(attrDef.component);
        const componentPopulate = {};
        
        // Add population for all special fields in the component
        for (const [compAttrName, compAttrDef] of Object.entries(componentModel.attributes)) {
          if (isRelationAttribute(compAttrDef) || isMediaAttribute(compAttrDef)) {
            componentPopulate[compAttrName] = true;
          }
        }
        
        // If the component has fields to populate, create a nested populate structure
        if (Object.keys(componentPopulate).length > 0) {
          populate[attrName] = { populate: componentPopulate };
        } else {
          populate[attrName] = true;
        }
      } else if (isDynamicZoneAttribute(attrDef)) {
        // For dynamic zones, create a populate structure for each possible component
        const dynamicZonePopulate = {};
        for (const componentName of attrDef.components) {
          const componentModel = getModel(componentName);
          for (const [compAttrName, compAttrDef] of Object.entries(componentModel.attributes)) {
            if (isRelationAttribute(compAttrDef) || isMediaAttribute(compAttrDef)) {
              dynamicZonePopulate[compAttrName] = true;
            }
          }
        }
        
        if (Object.keys(dynamicZonePopulate).length > 0) {
          populate[attrName] = { populate: '*' };
        } else {
          populate[attrName] = '*';
        }
      } else if (isRelationAttribute(attrDef)) {
        populate[attrName] = true;
      } else if (isMediaAttribute(attrDef)) {
        populate[attrName] = true;
      }
    }
  }

  console.log(`Populate object for ${slug}:`, JSON.stringify(populate, null, 2));
  return populate;
} 