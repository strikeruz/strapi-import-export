export const handleRequestErr = (err, handlers) => {
  const defaultHandler = handlers.default || (() => {});

  const { name: errorName, status: errorStatus } = err?.response?.error || {};
  const handler = handlers[errorName] || handlers[errorStatus] || defaultHandler;

  handler(err);
};
