# Import Export for Strapi 5
Import/Export data from and to your database for Strapi 5 - a fork of [strapi-import-export](https://github.com/Baboo7/strapi-plugin-import-export-entries), built from scratch using the [@strapi/sdk-plugin](https://docs.strapi.io/dev-docs/plugins/development/create-a-plugin).

Original by [Graeme Fulton](https://github.com/prototypr)
V3 fork by [Dalen Catt](https://github.com/Moonlight63)

<img width="160" src="https://github.com/user-attachments/assets/85fbb6ed-6d7e-408d-988e-ffeaee5de9f4"/>

### NPM Install:
`npm i strapi-import-export`

### Guide

~~Refer to the [original docs from the previous version](https://github.com/Baboo7/strapi-plugin-import-export-entries) for how this plugin works, it's exactly the same.~~


### Plugin Configuration
The plugin can be configured in your `config/plugins.js`:

```javascript
module.exports = {
  'strapi-import-export': {
    enabled: true,
    config: {
      // Server's public URL - used for media file URLs
      serverPublicHostname: 'https://your-server.com',
      // Maximum number of concurrent media downloads
      maxConcurrentDownloads: 5,
      // Other options...
    }
  }
}
```

---

### JSON v3 Format
The v3 format is a complete rewrite that focuses on properly handling draft/published content in Strapi 5:

#### Key Features
- **Draft/Published Support**: Properly handles both draft and published versions of content
- **Locale Support** (Experimental): Basic support for localized content - use with caution as this feature is still experimental
- **Smarter Relations**: More efficient relation handling with configurable max depth
- **Document ID Tracking**: Uses Strapi's document ID system for more reliable content tracking
- **Improved Media Handling**: Better handling of media files with absolute URLs
- **Bulk Export**: Export button appears in Strapi's bulk actions menu when entries are selected

#### Export Options
- **Export Relations**: Include related content in the export
  - When enabled, shows additional options:
    - **Deep Populate Relations**: Include relations of related content
    - **Deep Populate Component Relations**: Include relations within components
    - **Max Depth**: Control how deep to traverse relations (1-20 levels)
- **Export All Locales** (Experimental): Include all localized versions of content - not recommended for production use
- **Apply Filters and Sort**: Use current view's filters and sorting in export

#### Import Options
- **Existing Entry Action**: Choose how to handle existing entries
  - Warn: Show warning if the entry exists
  - Update: Update existing entries
  - Skip: Skip existing entries
- **Allow New Locales on Skip** (Experimental): When skipping existing entries, still allow creation of new locales
- **Ignore Missing Relations**: Continue import even if related entries are not found
- **Prevent Relation Changes**: When skipping existing entries, prevent changes to their relations

### ID Field Configuration
The v3 format uses a unique identifier field to track and match entries during import/export. This field must be both **required** and **unique** in your schema.

#### Setting Custom ID Field
You can configure which field to use as the identifier in your schema's plugin options:
```javascript
// In your schema configuration:
{
  pluginOptions: {
    'strapi-import-export': {
      idField: 'customField'  // The field to use as identifier
    }
  },
  attributes: {
    customField: {
      type: 'string',
      required: true,
      unique: true
    }
    // ... other attributes
  }
}
```

#### Automatic ID Field Selection
If no idField is configured, the plugin will automatically look for fields in this order:
1. `uid` - Typically a UUID from a custom field like Advanced-UUID
2. `name` - If the content type is a single entry type, this is a good default
3. `title` - Another common identifier field
4. `id` - Falls back to Strapi's internal ID as last resort, but will not be exported with the data

> **Note**: The selected field must be configured as both `required: true` and `unique: true` in your schema. The plugin will validate this and throw an error if the field is not properly configured.

### How It Works

#### Bulk Actions
The plugin adds an "Export" button to Strapi's bulk actions menu. This appears when you select one or more entries in the content manager:
- Select entries using the checkboxes in the list view
- Click the "Export" button in the bulk actions menu
- Choose your export options in the modal
- Only the selected entries will be exported

#### Export Process
1. **Initial Export**
   - Fetches all draft entries for the selected content type
   - For each draft, finds its corresponding published version
   - Groups content by locale (if localization is enabled)
   - Processes all relations, media, and components

2. **Relation Processing**
   - When Export Relations is enabled:
     - Tracks all relations encountered during export
     - After initial export, processes each related content type
     - Continues until max depth is reached or no new relations found
   - Relations are stored using their identifier field value

3. **Media Handling**
   - Media URLs are converted to absolute URLs using your server's public hostname (if the option is set in your plugin options).
   - Only the URL and metadata (name, alt text, caption, etc.) is exported, not the actual file

#### Import Process
1. **Validation**
   - Checks that all content types exist
   - Validates identifier fields are properly configured
   - Ensures required fields are present

2. **Entry Processing**
   - First processes published versions, then drafts
   - For each entry:
     1. Looks for existing entry using identifier field
     2. Handles according to Existing Entry Action setting
     3. Processes all relations, media, and components

3. **Media Import**
   - For each media field:
     1. **Existing Media Check**:
        - Looks for existing media with the same hash or filename
        - If found, reuses the existing media entry
     2. **New Media Import**:
        - If no match found, downloads the file from the URL
        - Creates a new media entry with the downloaded file
        - Preserves metadata like alt text and captions
     3. **Fallback Behavior**:
        - If download fails, logs a warning but continues import
        - The field will be set to null if media cannot be resolved

> **Note**: The import process is transactional per entry - if an entry fails to import, other entries will still be processed.


### Troubleshooting

#### Common Issues
- **Media Import Fails**: Check that your `serverPublicHostname` is configured correctly
- **Relations Not Found**: Ensure related content is included in the export or already exists in target system
- **ID Field Errors**: Verify your schema has properly configured unique identifier fields
- **Locale Issues**: Make sure both source and target systems have the same locales configured

#### Import Validation Errors
The plugin performs several validations before import:
- Schema existence and compatibility
- Required fields presence
- ID field configuration
- Media file accessibility


### Best Practices

- Always test imports on a staging environment first
- Use meaningful identifier fields (avoid relying on internal IDs)
- Keep relation depth reasonable (3-5 levels max) to avoid performance issues
- Back up your database before large imports
- For large datasets, consider splitting the export into smaller chunks
- Monitor the logs during import for any warnings or errors

---

### Strapi 5 Upgrades (v2)
There was a lot of work to migrate this plugin to Strapi 5 because of the size of it. The deprecated APIs were replaced, and all the deprecated components updated to the new Strapi design system.

- **Import** - seems to work okay (there is a known issue from the original plugin where the deepness dropdown doesn't work when the number of levels is high)
- **Export** - seems working, need testing
- Admin dashboard components (converted a lot of deprecated imports)
    - replaced select dropdowns
    - updated checkboxes to use radix api
    - loads of other similar stuff
- **Server** – converted to ESM so it can be used in Strapi 5
- **Removed most typescript** because it was causing issues, some types became out of date or could not be found.  
- **Replaced `strapi.entityService`** - this is deprecated, replaced with `strapi.documents`  

See video (this was when I first started):
[Watch on YouTube 📹](https://youtu.be/9TlyBMAC1xY)

#### Upgrade Guides:
These docs were most useful when migrating:

- [Strapi 5 Plugin Docs](https://docs.strapi.io/dev-docs/plugins/development/create-a-plugin)
- [Strapi 4 to 5 breaking changes](https://docs.strapi.io/dev-docs/migration/v4-to-v5/breaking-changes)
- [Strapi Helper plugin breaking changes](https://docs.strapi.io/dev-docs/migration/v4-to-v5/additional-resources/helper-plugin)
- [Strapi Entity Service Migration](https://docs.strapi.io/dev-docs/migration/v4-to-v5/additional-resources/from-entity-service-to-document-service#create)



