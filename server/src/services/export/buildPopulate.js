import {
  getModelAttributes,
  getModel,
  isRelationAttribute,
  isComponentAttribute,
  isDynamicZoneAttribute,
  isMediaAttribute,
} from '../../utils/models';

function buildComponentPopulate(componentModel, depth = 5, path = '') {
  if (depth < 1) return true;

  const componentPopulate = {};

  for (const [attrName, attrDef] of Object.entries(componentModel.attributes)) {
    if (!attrDef) continue;

    const currentPath = path ? `${path}.${attrName}` : attrName;

    if (isRelationAttribute(attrDef)) {
      componentPopulate[attrName] = true;
    } else if (isMediaAttribute(attrDef)) {
      componentPopulate[attrName] = true;
    } else if (isComponentAttribute(attrDef)) {
      const nestedComponentModel = getModel(attrDef.component);
      const nestedPopulate = buildComponentPopulate(nestedComponentModel, 1, currentPath);

      if (nestedPopulate === true) {
        componentPopulate[attrName] = true;
      } else {
        componentPopulate[attrName] = { populate: nestedPopulate };
      }
    } else if (isDynamicZoneAttribute(attrDef)) {
      const dynamicZonePopulate = {};

      for (const componentName of attrDef.components) {
        const dzComponentModel = getModel(componentName);
        const dzComponentPopulate = buildComponentPopulate(
          dzComponentModel,
          depth - 1,
          `${currentPath}.__component`
        );

        if (dzComponentPopulate !== true) {
          Object.assign(dynamicZonePopulate, dzComponentPopulate);
        }
      }

      componentPopulate[attrName] =
        Object.keys(dynamicZonePopulate).length > 0 ? { populate: dynamicZonePopulate } : true;
    }
  }

  return componentPopulate;
}

function buildDynamicZonePopulate(attr, depth = 5, path = '') {
  const populate = {
    on: {},
  };

  // Build populate structure for each possible component
  for (const componentName of attr.components) {
    const componentModel = getModel(componentName);
    console.log(`Building populate for dynamic zone component: ${componentName}`);

    // Get all attributes that need population in this component
    const componentPopulate = buildComponentPopulate(componentModel, depth - 1, path);

    // Add to the 'on' object using the proper format: 'category.name'
    populate.on[componentName] =
      componentPopulate === true ? { populate: '*' } : { populate: componentPopulate };
  }

  return populate;
}

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

    if (
      isRelationAttribute(attrDef) ||
      isComponentAttribute(attrDef) ||
      isDynamicZoneAttribute(attrDef) ||
      isMediaAttribute(attrDef)
    ) {
      console.log(`Found special attribute ${attrName} of type ${attrDef.type}`);

      if (isComponentAttribute(attrDef)) {
        console.log(`Building nested populate for component ${attrDef.component}`);
        const componentModel = getModel(attrDef.component);
        const componentPopulate = buildComponentPopulate(componentModel, depth - 1, attrName);

        populate[attrName] = componentPopulate === true ? true : { populate: componentPopulate };
      } else if (isDynamicZoneAttribute(attrDef)) {
        console.log(`Building dynamic zone populate for ${attrName}`);
        populate[attrName] = buildDynamicZonePopulate(attrDef, depth - 1, attrName);
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
