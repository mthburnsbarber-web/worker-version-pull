import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bindingsToConfig, moduleRules, pullVersion } from '../worker-version-pull.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');
const ID = '1e7d4b2c-0a9f-4c3e-8b21-6d5f0e9a7c34';
const version = (over = {}) => ({
  id: ID, number: 12, created_on: '2026-10-01T00:00:00Z', annotations: { 'workers/message': 'release 12' },
  compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'], main_module: 'index.js',
  modules: [
    { name: 'index.js', content_type: 'application/javascript+module', content_base64: b64('import u from "./lib/util.js"; export default { fetch() { return new Response(u) } }') },
    { name: 'lib/util.js', content_type: 'application/javascript+module', content_base64: b64('export default "ok"') },
    { name: 'page.js', content_type: 'text/plain', content_base64: b64('not code, served as text') },
    { name: 'add.wasm', content_type: 'application/wasm', content_base64: b64('\0asm') },
    { name: '_headers', content_type: 'text/plain', content_base64: b64('/*\n  X-Frame-Options: DENY\n') }
  ],
  bindings: [
    { type: 'plain_text', name: 'ORIGIN', text: 'https://api.example.com' },
    { type: 'json', name: 'LIMITS', json: { perDay: 200 } },
    { type: 'secret_text', name: 'API_KEY' },
    { type: 'kv_namespace', name: 'CACHE', namespace_id: 'kv1' },
    { type: 'r2_bucket', name: 'FILES', bucket_name: 'files', jurisdiction: 'eu' },
    { type: 'd1', name: 'DB', id: 'db1', database_id: 'db1' },
    { type: 'service', name: 'AUTH', service: 'auth', environment: 'production', entrypoint: 'Sessions' },
    { type: 'queue', name: 'JOBS', queue_name: 'jobs' },
    { type: 'durable_object_namespace', name: 'ROOMS', class_name: 'Room' },
    { type: 'ai', name: 'AI' },
    { type: 'assets', name: 'ASSETS' }
  ],
  assets: { config: { html_handling: 'none', not_found_handling: 'single-page-application', run_worker_first: true, base_path: '/' } },
  ...over
});

function fakeApi(v, { deployment = [{ version_id: ID, percentage: 100 }], subdomain = { enabled: false, previews_enabled: false }, tails = [{ service: 'logs' }] } = {}) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const path = url.replace('https://api.cloudflare.com/client/v4/accounts/acct', '');
    const result = path.endsWith('/deployments') ? { deployments: [{ versions: deployment }] }
      : path.includes('/versions?per_page') ? { items: [{ id: ID }, { id: '9f00aa11-0000-4000-8000-000000000000' }, { id: '9f00bb22-0000-4000-8000-000000000000' }] }
        : path.includes('/versions/') ? v
          : path.endsWith('/subdomain') ? subdomain
            : path.endsWith('/script-settings') ? { tail_consumers: tails, observability: { enabled: true } } : null;
    return new Response(JSON.stringify(result === null ? { success: false, errors: [{ message: 'not found' }] } : { success: true, result }), { status: result === null ? 404 : 200 });
  };
  return { fetcher, calls };
}
const opts = (fetcher) => ({ account: 'acct', token: 't', fetcher });
const jsonc = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\/\/.*$/gm, ''));

test('the live version becomes a folder Wrangler uploads again: same modules, types, bindings and settings', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'pull-')), 'out');
  const { fetcher } = fakeApi(version());
  const r = await pullVersion({ worker: 'shop', version: 'live', dir, ...opts(fetcher) });
  assert.deepEqual(r.refused, []);
  assert.equal(readFileSync(join(dir, 'src/lib/util.js'), 'utf8'), 'export default "ok"');
  assert.equal(readFileSync(join(dir, 'assets/_headers'), 'utf8'), '/*\n  X-Frame-Options: DENY\n', '_headers is asset configuration, not a module');
  assert.ok(!existsSync(join(dir, 'src/_headers')));
  const c = jsonc(join(dir, 'wrangler.jsonc'));
  assert.equal(c.main, 'src/index.js'); assert.equal(c.base_dir, 'src'); assert.equal(c.no_bundle, true); assert.equal(c.find_additional_modules, true);
  assert.deepEqual(c.rules, [
    { type: 'ESModule', globs: ['lib/util.js'], fallthrough: false },
    { type: 'Text', globs: ['page.js'], fallthrough: false },
    { type: 'CompiledWasm', globs: ['add.wasm'], fallthrough: false }
  ], 'a text file named *.js stays text');
  assert.deepEqual(c.compatibility_flags, ['nodejs_compat']);
  assert.equal(c.workers_dev, false); assert.equal(c.preview_urls, false, 'current settings are pinned so an upload cannot flip them');
  assert.deepEqual(c.tail_consumers, [{ service: 'logs' }]);
  assert.deepEqual(c.vars, { ORIGIN: 'https://api.example.com', LIMITS: { perDay: 200 } });
  assert.ok(!JSON.stringify(c).includes('API_KEY'), 'secrets are not written');
  assert.deepEqual(r.secrets, ['API_KEY']);
  assert.deepEqual(c.r2_buckets, [{ binding: 'FILES', bucket_name: 'files', jurisdiction: 'eu' }]);
  assert.deepEqual(c.d1_databases, [{ binding: 'DB', database_id: 'db1' }]);
  assert.deepEqual(c.services, [{ binding: 'AUTH', service: 'auth', environment: 'production', entrypoint: 'Sessions' }]);
  assert.deepEqual(c.durable_objects, { bindings: [{ name: 'ROOMS', class_name: 'Room' }] });
  assert.deepEqual(c.assets, { directory: './assets', binding: 'ASSETS', html_handling: 'none', not_found_handling: 'single-page-application', run_worker_first: true });
  assert.ok(!('observability' in c), 'observability is a Worker setting, not part of a version');
  const pulled = JSON.parse(readFileSync(join(dir, 'pulled.json'), 'utf8'));
  assert.equal(pulled.version, ID);
  assert.equal(pulled.files.find((f) => f.name === 'lib/util.js').sha256, createHash('sha256').update('export default "ok"').digest('hex'));
  assert.ok(r.notes.some((n) => /copy the files this version serves into assets/.test(n)), 'static files are called out');
});

test('nothing is written when a binding or the entry point would not upload the same', async () => {
  for (const [v, why] of [
    [version({ bindings: [{ type: 'some_future_binding', name: 'NEW' }] }), /^binding NEW \(some_future_binding\)$/],
    [version({ modules: [{ name: 'index.js', content_type: 'application/javascript', content_base64: b64('addEventListener("fetch", () => {})') }] }), /only ES module and Python Workers/],
    [version({ modules: [...version().modules, { name: 'odd[1].txt', content_type: 'text/plain', content_base64: b64('x') }] }), /glob characters/]
  ]) {
    const dir = join(mkdtempSync(join(tmpdir(), 'pull-')), 'out');
    const r = await pullVersion({ worker: 'shop', version: ID, dir, ...opts(fakeApi(v).fetcher) });
    assert.ok(r.refused.some((x) => why.test(x)), JSON.stringify(r.refused));
    assert.ok(!existsSync(dir), 'refused pulls write nothing');
  }
  const unsafe = version({ modules: [...version().modules, { name: '../escape.js', content_type: 'application/javascript+module', content_base64: b64('') }] });
  await assert.rejects(pullVersion({ worker: 'shop', version: ID, dir: join(tmpdir(), 'never'), ...opts(fakeApi(unsafe).fetcher) }), /unsafe module name/);
});

test('versions resolve from live, a full id or a unique prefix; a split deployment or an ambiguous prefix is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pull-'));
  assert.equal((await pullVersion({ worker: 'shop', version: '1e7d', dir: join(root, 'a'), ...opts(fakeApi(version()).fetcher) })).version, ID);
  await assert.rejects(pullVersion({ worker: 'shop', version: '9f00', dir: join(root, 'b'), ...opts(fakeApi(version()).fetcher) }), /more than one version/);
  const split = fakeApi(version(), { deployment: [{ version_id: ID, percentage: 99 }, { version_id: 'x', percentage: 1 }] });
  await assert.rejects(pullVersion({ worker: 'shop', version: 'live', dir: join(root, 'c'), ...opts(split.fetcher) }), /not on a single version/);
  writeFileSync(join(root, 'full'), '');
  await assert.rejects(pullVersion({ worker: 'shop', version: ID, dir: root, ...opts(fakeApi(version()).fetcher) }), /is not empty/);
});

test('mapping tables', () => {
  const { config, secrets, refused } = bindingsToConfig([
    { type: 'secret_key', name: 'SIGNING' }, { type: 'vectorize', name: 'IDX', index_name: 'docs' }, { type: 'hyperdrive', name: 'PG', id: 'h1' },
    { type: 'ratelimit', name: 'RL', namespace_id: '1001', simple: { limit: 10, period: 60 } }, { type: 'version_metadata', name: 'VERSION' },
    { type: 'workflow', name: 'FLOW', workflow_name: 'flow', class_name: 'Flow' }, { type: 'dispatch_namespace', name: 'D', namespace: 'n', outbound: { worker: { service: 'o' } } }
  ]);
  assert.deepEqual(secrets, ['SIGNING']);
  assert.deepEqual(config.vectorize, [{ binding: 'IDX', index_name: 'docs' }]);
  assert.deepEqual(config.ratelimits, [{ name: 'RL', namespace_id: '1001', simple: { limit: 10, period: 60 } }]);
  assert.deepEqual(config.version_metadata, { binding: 'VERSION' });
  assert.deepEqual(config.workflows, [{ binding: 'FLOW', name: 'flow', class_name: 'Flow' }]);
  assert.deepEqual(refused, ['D (dispatch namespace with an outbound Worker)']);
  assert.deepEqual(moduleRules([{ name: 'a.py', content_type: 'text/x-python' }, { name: 'm.js.map', content_type: 'application/source-map' }], 'main.py').rules,
    [{ type: 'PythonModule', globs: ['a.py'], fallthrough: false }]);
});
