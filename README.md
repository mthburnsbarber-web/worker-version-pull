# worker-version-pull

Download any Cloudflare Worker version, deployed or not, as a folder that `wrangler versions upload` sends back byte
for byte. Change one file, upload, and the new version runs exactly the code that runs now.

```
$ worker-version-pull my-worker live ./release
my-worker 1e7d4b2c-0a9f-4c3e-8b21-6d5f0e9a7c34 -> ./release: 17 files, entry src/index.js, 4 secrets kept on upload
NOTE static files cannot be downloaded through the API: copy the files this version serves into assets/ before uploading, or the new version serves none
next: cd ./release && npx wrangler versions upload -c wrangler.jsonc --message "<what changed>"
```

## Why

You need to change a Worker without changing its code: new static files, a moved origin URL, a fixed `_headers`.
The code on disk is the problem. It might be a branch that never shipped, a bundle built with different flags, or a
tree missing someone's hotfix. Rebuilding from it ships all of that along with your one change.

So start from what runs. This tool reads a version back from Cloudflare and writes:

- **`src/`**: every module exactly as stored, including hashed text modules such as `3f2a…-page.html` or
  `9c1e…-client.js.txt`.
- **`wrangler.jsonc`**:
  - `no_bundle` with one rule per module type, listing each file by name, so every module goes back with the type it
    had. A text file named `*.js` stays text, and a `.css` file stays text.
  - The entry point, compatibility date and flags, limits and placement.
  - Every binding Wrangler can declare: vars, JSON vars, KV, R2 (with jurisdiction), D1, services (with entrypoints),
    queues, Durable Objects, Workflows, AI, Vectorize, Hyperdrive, rate limits and more.
  - The static-asset routing: `run_worker_first`, `html_handling` and `not_found_handling`.
- **`assets/`**: `_headers` and `_redirects`, which a version stores beside its code but which Wrangler reads from
  the assets folder.
- **`pulled.json`**: the SHA-256 of every file, for your records.

It also pins the Worker's current workers.dev, Preview URL and tail consumer settings. Wrangler's defaults would
otherwise turn the workers.dev address on for a Worker with no routes in its file the next time someone runs
`wrangler deploy` with it.

Secrets are listed, not written. Nobody can download them, and nobody needs to: `wrangler versions upload` keeps
every secret of the previous version.

Anything that would not go back the same is refused, and nothing is written: an unknown binding type, a
service-worker script, a dispatch namespace with an outbound Worker, or a module name containing glob characters.

## Usage

```
worker-version-pull <worker> [version-id|prefix|live] <dir> [--json]
```

- `version`: a full version ID, a unique prefix such as `1e7d4b2c` (looked up among the latest 100 versions), or
  `live`, the version serving 100% of traffic. Defaults to `live`. During a gradual deployment, name the version.
- `<dir>`: must be empty or missing.

Environment: `CLOUDFLARE_API_TOKEN` (needs Workers Scripts: Read) and `CLOUDFLARE_ACCOUNT_ID`.

Exit codes: `0` written, `1` refused, `2` usage or API error. Zero dependencies, plain Node 20+. Run it without
installing: `npx github:mthburnsbarber-web/worker-version-pull <worker> live <dir>`.

## The release this was built for

```bash
npx github:mthburnsbarber-web/worker-version-pull my-worker live ./release
cp -R ./site/. ./release/assets/            # the static files, which the API cannot return
cd ./release
id=$(npx wrangler versions upload -c wrangler.jsonc --message "new photos" | sed -n 's/^Worker Version ID: //p')
npx github:mthburnsbarber-web/worker-version-verify my-worker "$id"   # same code, bindings and settings as live
npx wrangler versions deploy "$id@1%" "<live-version>@99%" -y
```

[worker-version-verify](https://github.com/mthburnsbarber-web/worker-version-verify) proves the uploaded version
matches the one you pulled, and its canary script sends 1% of traffic first.

It was checked against real versions: Wrangler's dry run of a pulled 17-module Worker wrote all 17 modules back with
the same SHA-256. ES modules, text, CompiledWasm and Data modules all keep their type.

## What it doesn't do

- It does not download static files. Cloudflare has no API for a version's assets. Copy them from your source or
  build output into `assets/`. If you upload without them, the new version serves none.
- It does not copy routes, custom domains, cron triggers, queue consumers, logs or observability. Those are Worker
  settings, not part of a version, so they are left out on purpose. Use `wrangler versions upload` with this folder,
  not `wrangler deploy`.
- It does not apply Durable Object migrations. A class whose migration has already run uploads fine.

## License

MIT
