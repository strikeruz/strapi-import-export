export default {
  type: 'admin',
  routes: [
    {
      method: 'GET',
      path: '/import/model-attributes/:slug',
      handler: 'importAdmin.getModelAttributes',
      config: {
        policies: [],
      },
    },
    {
      method: 'POST',
      path: '/import',
      handler: 'importAdmin.importData',
      config: {
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/import/progress',
      handler: 'importAdmin.importSSE',
      config: {
        policies: [],
      },
    },
  ],
};
