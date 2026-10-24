#!/usr/bin/env node
// worker-version-pull — download any Cloudflare Worker version as a folder that Wrangler uploads again, byte for byte.
//
// Modules are written exactly as the version stores them (src/). Its `_headers` and `_redirects` go to assets/, since
// they are static-asset configuration, not code. wrangler.jsonc reproduces the version: entry point, the type of every
// module, compatibility date and flags, every binding Wrangler can declare, static-asset routing, limits and placement.
// It also pins the Worker's current workers.dev, Preview URL and tail consumer settings, so an upload cannot change
// them. Secrets cannot be downloaded and do not need to be: `wrangler versions upload` keeps them. Static files cannot
// be downloaded through the API either: put yours in assets/ before uploading. Zero dependencies.
//
// Usage: worker-version-pull <worker> [version-id|prefix|live] <dir> [--json]
// Env:   CLOUDFLARE_API_TOKEN (Workers Scripts: Read), CLOUDFLARE_ACCOUNT_ID
// Exit:  0 written, 1 refused (something would not upload the same), 2 usage or API error
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const STATIC_CONFIG = new Set(['_headers', '_redirects']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Module content type as stored by Cloudflare, to the Wrangler rule type that uploads it with that content type.
const RULE_TYPES = {
  'application/javascript+module': 'ESModule',
  'application/javascript': 'CommonJS',
  'text/plain': 'Text',
  'application/octet-stream': 'Data',
  'application/wasm': 'CompiledWasm',
  'text/x-python': 'PythonModule',
  'text/x-python-requirement': 'PythonRequirement'
};

export async function cloudflare(path, { token, fetcher = fetch } = {}) {
  const response = await fetcher(API + path, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(`Cloudflare API ${response.status} for ${path}: ${(body.errors || []).map((e) => e.message).join('; ') || 'no detail'}`);
  return body.result;
}

// `live` is the version serving 100% of traffic; a short prefix is looked up among the latest 100 versions.
export async function resolveVersion(worker, version, { account, token, fetcher }) {
  if (UUID.test(version)) return version;
  if (version === 'live') {
    const versions = (await cloudflare(`/accounts/${account}/workers/scripts/${worker}/deployments`, { token, fetcher }))?.deployments?.[0]?.versions || [];
    if (versions.length !== 1) throw new Error(`${worker} is not on a single version (${versions.map((v) => `${v.version_id}@${v.percentage}%`).join(', ') || 'no deployment'}); name the version`);
    return versions[0].version_id;
  }
  if (!/^[0-9a-f]{4,}/.test(version)) throw new Error(`not a version id: ${version}`);
  const ids = ((await cloudflare(`/accounts/${account}/workers/scripts/${worker}/versions?per_page=100`, { token, fetcher }))?.items || []).map((v) => v.id).filter((id) => id.startsWith(version));
  if (ids.length !== 1) throw new Error(`${ids.length ? 'more than one' : 'no'} version of ${worker} among the latest 100 starts with ${version}`);
  return ids[0];
}

// Bindings to Wrangler configuration, field for field. Secrets are listed, not written: uploads keep them. A type with no
// faithful declaration is refused rather than dropped, since the new version would silently lose it.
export function bindingsToConfig(bindings = []) {
  const config = {}, secrets = [], refused = [];
  const push = (key, item) => { (config[key] ??= []).push(item); };
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
  for (const b of bindings) {
    switch (b.type) {
      case 'plain_text': (config.vars ??= {})[b.name] = b.text; break;
      case 'json': (config.vars ??= {})[b.name] = b.json; break;
      case 'secret_text': case 'secret_key': secrets.push(b.name); break;
      case 'kv_namespace': push('kv_namespaces', { binding: b.name, id: b.namespace_id }); break;
      case 'r2_bucket': push('r2_buckets', clean({ binding: b.name, bucket_name: b.bucket_name, jurisdiction: b.jurisdiction })); break;
      case 'd1': push('d1_databases', { binding: b.name, database_id: b.database_id || b.id }); break;
      case 'service': push('services', clean({ binding: b.name, service: b.service, environment: b.environment, entrypoint: b.entrypoint })); break;
      case 'queue': (config.queues ??= { producers: [] }).producers.push(clean({ binding: b.name, queue: b.queue_name, delivery_delay: b.delivery_delay })); break;
      case 'durable_object_namespace': (config.durable_objects ??= { bindings: [] }).bindings.push(clean({ name: b.name, class_name: b.class_name, script_name: b.script_name, environment: b.environment })); break;
      case 'workflow': push('workflows', clean({ binding: b.name, name: b.workflow_name, class_name: b.class_name, script_name: b.script_name })); break;
      case 'analytics_engine': push('analytics_engine_datasets', { binding: b.name, dataset: b.dataset }); break;
      case 'vectorize': push('vectorize', { binding: b.name, index_name: b.index_name }); break;
      case 'hyperdrive': push('hyperdrive', { binding: b.name, id: b.id }); break;
      case 'mtls_certificate': push('mtls_certificates', { binding: b.name, certificate_id: b.certificate_id }); break;
      case 'secrets_store_secret': push('secrets_store_secrets', { binding: b.name, store_id: b.store_id, secret_name: b.secret_name }); break;
      case 'send_email': push('send_email', clean({ name: b.name, destination_address: b.destination_address, allowed_destination_addresses: b.allowed_destination_addresses, allowed_sender_addresses: b.allowed_sender_addresses })); break;
      case 'pipelines': push('pipelines', clean({ binding: b.name, stream: b.stream, pipeline: b.pipeline })); break;
      case 'ratelimit': push('ratelimits', { name: b.name, namespace_id: b.namespace_id, simple: { limit: b.simple?.limit, period: b.simple?.period } }); break;
      case 'dispatch_namespace':
        if (b.outbound) refused.push(`${b.name} (dispatch namespace with an outbound Worker)`);
        else push('dispatch_namespaces', { binding: b.name, namespace: b.namespace });
        break;
      case 'ai': case 'browser': case 'images': case 'version_metadata': config[b.type] = { binding: b.name }; break;
      case 'assets': break; // written with the asset routing below
      default: refused.push(`${b.name} (${b.type})`);
    }
  }
  return { config, secrets, refused };
}

// One rule per module type, listing each module by its exact path. `fallthrough: false` drops Wrangler's default rule for
// that type, so exactly these files are found, each with the type the version stored (a text file named *.js stays text).
export function moduleRules(modules, main) {
  const byType = new Map(), refused = [];
  for (const m of modules) {
    if (m.name === main || STATIC_CONFIG.has(m.name) || m.content_type === 'application/source-map') continue;
    const type = RULE_TYPES[m.content_type];
    if (!type) { refused.push(`${m.name} (${m.content_type})`); continue; }
    if (/[*?[\]{}!]/.test(m.name)) { refused.push(`${m.name} (glob characters in the name)`); continue; }
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(m.name);
  }
  return { rules: [...byType].map(([type, globs]) => ({ type, globs: globs.sort(), fallthrough: false })), refused };
}

const safeName = (name) => {
  const n = String(name).replace(/^\.\//, '');
  if (!n || n.startsWith('/') || n.includes('\\') || n.split('/').some((part) => part === '..' || part === '')) throw new Error(`unsafe module name ${JSON.stringify(name)}`);
  return n;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function buildConfig(version, { worker, account, subdomain = null, tailConsumers = null }) {
  const modules = (version.modules || []).map((m) => ({ ...m, name: safeName(m.name) }));
  const main = safeName(version.main_module || '');
  const refused = [], notes = [];
  const mainModule = modules.find((m) => m.name === main);
  if (!mainModule) refused.push(`main module ${main} is not among the modules`);
  else if (!['application/javascript+module', 'text/x-python'].includes(mainModule.content_type)) refused.push(`main module ${main} is ${mainModule.content_type}; only ES module and Python Workers can be uploaded again`);
  const rules = moduleRules(modules, main);
  const bindings = bindingsToConfig(version.bindings);
  refused.push(...rules.refused.map((r) => `module ${r}`), ...bindings.refused.map((r) => `binding ${r}`));

  const config = {
    name: worker,
    account_id: account,
    main: `src/${main}`,
    base_dir: 'src',
    no_bundle: true,
    find_additional_modules: true,
    ...(rules.rules.length ? { rules: rules.rules } : {}),
    compatibility_date: version.compatibility_date,
    ...(version.compatibility_flags?.length ? { compatibility_flags: version.compatibility_flags } : {})
  };
  if (subdomain) Object.assign(config, { workers_dev: subdomain.enabled === true, preview_urls: subdomain.previews_enabled === true });
  else notes.push('workers.dev and Preview URL settings could not be read and are not pinned');
  if (Array.isArray(tailConsumers)) { if (tailConsumers.length) config.tail_consumers = tailConsumers.map((t) => ({ service: t.service, ...(t.environment ? { environment: t.environment } : {}) })); }
  else notes.push('tail consumers could not be read and are not pinned');
  if (version.limits && Object.keys(version.limits).length) config.limits = version.limits;
  if (version.placement && Object.keys(version.placement).length) config.placement = version.placement;
  if (modules.some((m) => m.content_type === 'application/source-map')) {
    config.upload_source_maps = true;
    notes.push('source maps are written to src/; Wrangler uploads them only when the module that names them is found');
  }
  Object.assign(config, bindings.config);

  const assetBinding = (version.bindings || []).find((b) => b.type === 'assets');
  const routing = version.assets?.config || null;
  if (assetBinding || routing || modules.some((m) => STATIC_CONFIG.has(m.name))) {
    config.assets = { directory: './assets', ...(assetBinding ? { binding: assetBinding.name } : {}) };
    for (const key of ['html_handling', 'not_found_handling', 'run_worker_first']) if (routing?.[key] !== undefined) config.assets[key] = routing[key];
    if (routing?.base_path && routing.base_path !== '/') notes.push(`static assets are served under base path ${routing.base_path}, which wrangler.jsonc cannot declare`);
    notes.push('static files cannot be downloaded through the API: copy the files this version serves into assets/ before uploading, or the new version serves none');
  }
  for (const key of ['containers', 'cache_options']) if (version[key]) notes.push(`${key} are not reproduced`);
  return { config, modules, main, secrets: bindings.secrets, refused, notes };
}

export function writePull(dir, version, built) {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const files = [];
  for (const m of built.modules) {
    const bytes = Buffer.from(m.content_base64 || '', 'base64');
    const path = STATIC_CONFIG.has(m.name) ? join(dir, 'assets', m.name) : join(dir, 'src', m.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    files.push({ name: m.name, path: path.slice(dir.length + 1), content_type: m.content_type, bytes: bytes.length, sha256: sha256(bytes) });
  }
  if (built.config.assets) mkdirSync(join(dir, 'assets'), { recursive: true });
  const message = version.annotations?.['workers/message'];
  const header = [
    `// ${built.config.name} version ${version.id}${version.number ? ` (#${version.number})` : ''}, created ${version.created_on || 'at an unknown time'}${message ? `: ${message}` : ''}`,
    '// Written by worker-version-pull. Upload with `wrangler versions upload -c wrangler.jsonc`, check the result with',
    `// worker-version-verify ${built.config.name} <new-version> ${version.id}, then deploy with \`wrangler versions deploy\`.`,
    built.secrets.length ? `// Secrets kept by Wrangler on upload (values are never downloadable): ${built.secrets.join(', ')}.` : '// The version has no secrets.',
    '// Routes, custom domains, cron triggers, queue consumers, logs and observability are Worker settings, not part of a',
    '// version, and are left out on purpose: use `versions upload`, not `wrangler deploy`, with this file.'
  ].join('\n');
  writeFileSync(join(dir, 'wrangler.jsonc'), `${header}\n${JSON.stringify(built.config, null, 2)}\n`);
  const pulled = { worker: built.config.name, version: version.id, number: version.number, created_on: version.created_on, main_module: built.main, secrets: built.secrets, notes: built.notes, files };
  writeFileSync(join(dir, 'pulled.json'), JSON.stringify(pulled, null, 2) + '\n');
  return pulled;
}

export async function pullVersion({ worker, version = 'live', dir, account, token, fetcher }) {
  const id = await resolveVersion(worker, version, { account, token, fetcher });
  const data = await cloudflare(`/accounts/${account}/workers/workers/${worker}/versions/${id}?include=modules`, { token, fetcher });
  const subdomain = await cloudflare(`/accounts/${account}/workers/scripts/${worker}/subdomain`, { token, fetcher }).catch(() => null);
  const settings = await cloudflare(`/accounts/${account}/workers/scripts/${worker}/script-settings`, { token, fetcher }).catch(() => null);
  const built = buildConfig(data, { worker, account, subdomain, tailConsumers: settings ? settings.tail_consumers || [] : null });
  if (built.refused.length) return { worker, version: id, refused: built.refused, notes: built.notes };
  return { ...writePull(dir, data, built), refused: [] };
}

// Run as a command, also through an npm bin symlink or from a path with spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2), json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const [worker, version, dir] = rest.length === 2 ? [rest[0], 'live', rest[1]] : rest;
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!worker || !version || !dir || rest.length > 3 || !token || !account) {
    console.error('usage: worker-version-pull <worker> [version-id|prefix|live] <dir> [--json]\nenv: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID');
    process.exit(2);
  }
  try {
    const r = await pullVersion({ worker, version, dir, account, token });
    if (json) console.log(JSON.stringify(r, null, 2));
    else if (r.refused.length) console.log(`REFUSED ${worker} ${r.version}: nothing written, because it would not upload the same:\n${r.refused.map((x) => `  ${x}`).join('\n')}`);
    else {
      console.log(`${worker} ${r.version} -> ${dir}: ${r.files.length} files, entry src/${r.main_module}${r.secrets.length ? `, ${r.secrets.length} secrets kept on upload` : ''}`);
      for (const n of r.notes) console.log(`NOTE ${n}`);
      console.log(`next: cd ${dir} && npx wrangler versions upload -c wrangler.jsonc --message "<what changed>"`);
    }
    process.exit(r.refused.length ? 1 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
