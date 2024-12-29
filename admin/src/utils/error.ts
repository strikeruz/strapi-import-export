import { FetchError } from "@strapi/strapi/admin";

export const handleRequestErr = (err: FetchError, handlers: { [x: string]: any; }) => {
  const defaultHandler = handlers.default || (() => {});

  const { name: errorName, status: errorStatus } = err.response?.data.error || {  };

  const handler = handlers[errorName as string] || handlers[errorStatus as number] || defaultHandler;

  handler(err);
};
