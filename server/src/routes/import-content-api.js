export default {
  type: 'content-api',
  routes: [
    {
      method: 'POST',
      path: '/content/import',
      handler: 'import.importData',
      config: {
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/content/import/progress',
      handler: 'import.importSSE',
      config: {
        policies: [],
      },
    },
  ],
};
