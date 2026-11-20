// Run with the offline guard preloaded (node --require e2e/offline-guard.cjs):
// tries to reach a "forbidden" server every way the guard must stop, and an
// allowed loopback server as the control. Everything here is loopback — the
// forbidden target is 127.0.0.2, which the guard treats like any remote host.
// Prints one JSON object: what each attempt returned.
//
//   node --require e2e/offline-guard.cjs net-probe.cjs <targetPort> <redirectPort> <controlPort>
const http = require('http');
const net = require('net');

const [targetPort, redirectPort, controlPort] = process.argv.slice(2).map(Number);

const outcome = (p) =>
  p.then(
    (r) => (typeof r === 'number' ? `status ${r}` : String(r)),
    (e) => `refused: ${(e && (e.cause?.code || e.code || e.message)) || e}`,
  );
const viaFetch = (url) => outcome(fetch(url).then((r) => r.status));
const viaHttp = (opts) =>
  outcome(
    new Promise((resolve, reject) => {
      try {
        const req = http.get(opts, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
      } catch (e) {
        reject(e);
      }
    }),
  );
const viaSocket = (host, port) =>
  outcome(
    new Promise((resolve, reject) => {
      const s = net.connect({ host, port }, () => {
        s.destroy();
        resolve('connected');
      });
      s.on('error', reject);
    }),
  );

(async () => {
  const out = {
    // The forbidden target, every way.
    direct: await viaFetch(`http://127.0.0.2:${targetPort}/direct`),
    mappedHex: await viaFetch(`http://[::ffff:7f00:2]:${targetPort}/mapped-hex`),
    mappedDotted: await viaFetch(`http://[::ffff:127.0.0.2]:${targetPort}/mapped-dotted`),
    redirect: await viaFetch(`http://127.0.0.1:${redirectPort}/to-target`),
    httpMapped: await viaHttp({ host: '::ffff:127.0.0.2', port: targetPort, path: '/http-mapped' }),
    socket: await viaSocket('127.0.0.2', targetPort),
    // Controls: loopback stays reachable.
    control: await viaFetch(`http://127.0.0.1:${controlPort}/control`),
    controlMapped: await viaFetch(`http://[::ffff:127.0.0.1]:${controlPort}/control-mapped`),
    controlHttp: await viaHttp({ host: 'localhost', family: 4, port: controlPort, path: '/control-http' }),
  };
  process.stdout.write(JSON.stringify(out));
})();
