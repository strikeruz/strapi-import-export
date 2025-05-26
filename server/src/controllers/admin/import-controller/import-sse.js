import { getService } from '../../../utils/utils.js';

const importSSE = async (ctx) => {
  // Check permissions
  //   if (!hasPermissions(ctx)) {
  //     return ctx.forbidden();
  //   }
  // console.log('SSE request received:',
  //     JSON.stringify(ctx, null, 2)
  // );

  // Explicitly set status to 200 OK
  ctx.status = 200;

  // Set headers for SSE
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Keep connection open
  ctx.req.socket.setTimeout(0);

  // Create a client for this connection
  const sseClient = {
    send: (event, data) => {
      ctx.res.write(`event: ${event}\n`);
      ctx.res.write(`data: ${JSON.stringify(data)}\n\n`);
      ctx.res.flush && ctx.res.flush();
    },
  };

  // Register this client with the import service
  const importService = getService('import');
  importService.setSSEClient(sseClient);

  // Handle client disconnect
  ctx.req.on('close', () => {
    importService.clearSSEClient();
  });

  // Send initial connection message
  sseClient.send('connected', { message: 'SSE connection established' });

  // Keep the request open
  return new Promise(() => {});
};

function hasPermissions(ctx) {
  const { userAbility } = ctx.state;

  // Basic permission check - admin can access SSE
  return userAbility.can('access', 'plugin::import-export.read');
}

export default ({ strapi }) => importSSE;
