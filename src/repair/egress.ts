// The repair box's only way out. The box sits alone on an internal Docker network with no route anywhere, so it can
// reach neither the host (host.docker.internal and every 127.0.0.1 listener behind it, such as the controller and the
// twins) nor the local network. Its package managers go through this HTTP(S) proxy, which runs in its own container on
// the default bridge and forwards only to public addresses: a destination that is, or resolves to, a loopback, private,
// link-local, shared, reserved or multicast address is refused, and the address it checked is the one it connects to.

/** The proxy's image, user and port inside the box's network, where it answers as `proxy`. */
export const EGRESS = { image: 'node:22-bookworm-slim', user: 'node', port: 3128, alias: 'proxy' };
/** Addresses that are not the public internet. */
export const CLOSED_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24',
  '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3',
  '::/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8',
];
/** The environment that sends the box's package managers, git, curl, JVMs and Node through the proxy. */
export function egressEnvironment() {
  const proxy = `http://${EGRESS.alias}:${EGRESS.port}`, local = 'localhost,127.0.0.1,::1';
  return {
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: local, no_proxy: local, NODE_USE_ENV_PROXY: '1',
    JAVA_TOOL_OPTIONS: `-Dhttp.proxyHost=${EGRESS.alias} -Dhttp.proxyPort=${EGRESS.port} -Dhttps.proxyHost=${EGRESS.alias} -Dhttps.proxyPort=${EGRESS.port} -Dhttp.nonProxyHosts=localhost|127.0.0.1`,
  };
}

/**
 * The proxy, run as `node -e EGRESS_SCRIPT [port]`: CONNECT tunnels and absolute-form http:// requests to public
 * addresses only. It prints the port it listens on.
 */
export const EGRESS_SCRIPT = `'use strict';
const http = require('node:http'), net = require('node:net'), dns = require('node:dns');
const blocked = new net.BlockList();
for (const range of ${JSON.stringify(CLOSED_RANGES)}) { const [address, prefix] = range.split('/'); blocked.addSubnet(address, Number(prefix), net.isIPv6(address) ? 'ipv6' : 'ipv4'); }
const closed = address => blocked.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
const refused = host => Object.assign(new Error(host + ' is not a public address.'), { code: 'EREFUSED' });
function lookup(host, options, done) {
  if (typeof options === 'function') { done = options; options = {}; }
  dns.lookup(host, { all: true, verbatim: true }, (error, found) => {
    if (error) return done(error);
    if (!found.length || found.some(item => closed(item.address))) return done(refused(host));
    if (options.all) return done(null, found);
    done(null, found[0].address, found[0].family);
  });
}
const open = host => Boolean(host) && (!net.isIP(host) || !closed(host));
const status = error => error && error.code === 'EREFUSED' ? '403 Forbidden' : '502 Bad Gateway';
const server = http.createServer((request, response) => {
  let target = null;
  try { target = new URL(request.url); } catch {}
  const host = target ? target.hostname.replace(/^\\[|\\]$/g, '') : '';
  if (!target || target.protocol !== 'http:' || !open(host)) return void response.writeHead(403, { connection: 'close' }).end();
  const headers = { ...request.headers };
  delete headers['proxy-connection']; delete headers['proxy-authorization'];
  const upstream = http.request({ host, port: Number(target.port) || 80, path: target.pathname + target.search, method: request.method, headers, lookup, setHost: false }, answer => {
    response.writeHead(answer.statusCode || 502, answer.headers);
    answer.pipe(response);
  });
  upstream.on('error', error => { if (!response.headersSent) response.writeHead(Number(status(error).slice(0, 3)), { connection: 'close' }); response.end(); });
  request.pipe(upstream);
});
server.on('connect', (request, client, head) => {
  const match = /^(?:\\[([\\da-f:.]+)\\]|([\\w.-]+)):(\\d{1,5})$/i.exec(request.url || '');
  const host = match ? match[1] || match[2] : '', port = match ? Number(match[3]) : 0;
  const deny = reason => client.end('HTTP/1.1 ' + reason + '\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');
  client.on('error', () => {});
  if (!open(host) || port < 1 || port > 65535) return deny('403 Forbidden');
  let established = false;
  const upstream = net.connect({ host, port, lookup }, () => {
    established = true;
    client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  upstream.on('error', error => { if (established) client.destroy(); else deny(status(error)); });
  client.on('close', () => upstream.destroy());
});
server.listen(process.argv[1] === undefined ? ${EGRESS.port} : Number(process.argv[1]), () => process.stdout.write(server.address().port + '\\n'));
`;
