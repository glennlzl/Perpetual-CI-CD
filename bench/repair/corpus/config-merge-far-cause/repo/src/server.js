// Serves the app over HTTP with JSON bodies: node src/server.js.
import { createServer } from 'node:http';
import { createApp } from './app.js';

/** Listens on the app's configured host and port; returns the server. */
export function serve(app = createApp()) {
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    let result;
    try {
      result = app.handle({ method: request.method, path: request.url, body: text ? JSON.parse(text) : null });
    } catch (error) {
      if (!(error instanceof SyntaxError)) console.error(error);
      result = error instanceof SyntaxError ? { status: 400, body: { error: 'Send a JSON body.' } } : { status: 500, body: { error: 'Something went wrong.' } };
    }
    response.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
  });
  return server.listen(app.config.server.port, app.config.server.host);
}

if (process.argv[1] === import.meta.filename) serve();
