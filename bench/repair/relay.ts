// The gateway relay: a TCP forwarder that joins a bench box's internal network as `gateway` and pipes every connection
// to one fixed host port, the model gateway's, and nowhere else. It runs as `node -e RELAY_SCRIPT <listen port> <host>
// <target port>` in its own locked-down container and prints the port it listens on.

/** The relay's port inside the box's network and the alias it answers to. */
export const RELAY = { port: 8080, alias: 'gateway' };

export const RELAY_SCRIPT = `'use strict';
const net = require('node:net');
const [listen, host, target] = process.argv.slice(1);
const server = net.createServer(client => {
  const upstream = net.connect({ host, port: Number(target) });
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
server.listen(Number(listen), () => process.stdout.write(server.address().port + '\\n'));
`;
