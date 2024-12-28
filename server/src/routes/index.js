import exportAdminRoutes from './export-admin';
import importAdminRoutes from './import-admin';
import exportContentApiRoutes from './export-content-api';
import importContentApiRoutes from './import-content-api';

export default {
  exportAdminRoutes,
  importAdminRoutes,
  export: exportContentApiRoutes,
  import: importContentApiRoutes,
};
