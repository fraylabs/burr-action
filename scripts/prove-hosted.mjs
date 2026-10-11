// Run on Boat: node scripts/prove-hosted.mjs
// Exercise the importable production client over real local HTTP connections.
import assert from 'node:assert/strict';
import http from 'node:http';
import { hostedExtras } from './hosted.mjs';
const server = http.createServer(async (req, res) => {
  const mode = req.headers.authorization?.slice(7);
  if (mode === 'slow') return;
  if (mode === 'slow-stages') await new Promise(resolve => setTimeout(resolve, 110));
  if (mode === 'invalid') { res.writeHead(401); return res.end('{}'); }
  if (mode === 'http-error') { res.writeHead(503); return res.end('{}'); }
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'malformed') return res.end('{');
  if (req.url === '/api/v1/licence') return res.end(JSON.stringify({ valid: true, plan: 'pro', org: mode === 'wrong-org' ? 'other' : 'fraylabs', privateRepoLimit: 5 }));
  if (req.url.endsWith('/baseline')) return res.end('{"baseline":null}');
  if (req.url.endsWith('/history')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); assert.equal(body.runId, 'proof');
    assert.equal(body.status, 'interference');
    return res.end('{"stored":true}');
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const report = { status: 'interference', assemblies: [{ findings: [{ id: 'proven-overlap' }], pair_set_complete: false }] };
try {
  for (const token of ['', 'invalid', 'http-error', 'malformed', 'wrong-org', 'slow', 'slow-stages', 'valid']) {
    const before = JSON.stringify(report), start = performance.now();
    const result = await hostedExtras({ token, repository: 'fraylabs/demo', runId: 'proof', report, baseUrl, timeoutMs: 200 });
    assert.equal(JSON.stringify(report), before);
    assert.equal(result.status === 'history stored', token === 'valid');
    assert.ok(performance.now() - start < 1000, 'total deadline exceeded');
    console.log(`${token || 'missing'}: ${result.status}; interference verdict retained`);
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
const result = await hostedExtras({ token: 'fixture', repository: 'fraylabs/demo', report, baseUrl, timeoutMs: 200 });
assert.ok(result.status.startsWith('skipped'));
assert.equal(report.status, 'interference');
console.log('refused connection: extras skipped; interference verdict retained');
const started = performance.now();
const ignoredAbort = await hostedExtras({ token: 'fixture', repository: 'fraylabs/demo', report, timeoutMs: 200, fetchImpl: () => new Promise(() => {}) });
assert.ok(ignoredAbort.status.startsWith('skipped'));
assert.ok(performance.now() - started < 1000);
console.log('unresponsive transport: total deadline retained');
