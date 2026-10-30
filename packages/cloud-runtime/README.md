# Cloud runtime helper

This is the Node transport for the first Vercel cloud slice. It runs the existing
Linux FalconDeck daemon, which starts Codex through its existing `app-server`
adapter. It does not implement an agent loop. The SDK is pinned to
`@vercel/sandbox` **3.9.1**, verified against the npm package and official SDK
reference on 2026-10-30.

The image and live provider flow have **not** been built or qualified. Tests use
an injected SDK and temporary local repositories. Nothing in the tests creates a
billable sandbox, publishes an image, or reads local credentials.

## Invocation

Use Node 22 or newer after `npm install` at the monorepo root:

```sh
node packages/cloud-runtime/src/cli.mjs < private-request.json
npm test --workspace @falcondeck/cloud-runtime
```

The CLI reads one JSON request from stdin and prints one JSON response to stdout.
It accepts no secret arguments and never prints raw SDK errors. A failure exits
nonzero with `{ "error": { "code": "...", "message": "...", "sandbox_id": "..." } }`.
The sandbox ID is included when reconciliation may be necessary. Do not log the
request, gateway token, API key, or provider credentials. Delete temporary request
files immediately if a caller uses files instead of a pipe.

Every request includes `operation` and explicit
`credentials: { token, teamId, projectId }`. Ambient Vercel credentials are not
accepted. All operations after create include `sandbox_id`, which is the
provider's durable **sandbox name**, not an ephemeral session ID.

| Operation | Additional request fields | Result |
| --- | --- | --- |
| `create` | `name?`, `image`, `timeout_ms`, `cpus`, `allowed_domains`, `openai_api_key`, `source`, `worker_daemon_url?`, `worker_daemon_sha256?`, `model_base_url?` | `sandbox_id`, `gateway_url`, `gateway_token`, `workspace_path`, `expires_at`, `snapshot_expiration_ms` |
| `inspect` | none | `sandbox_id`, `status`, `expires_at`, `current_snapshot_id`, `persistent`, `snapshot_expiration_ms` |
| `export` | none; environment must be running | result manifest described below |
| `resume` | `openai_api_key`, `timeout_ms?`, `model_base_url?` | fresh gateway URL/token and current deadline |
| `stop` | none | updated environment metadata with bounded retained snapshot |
| `delete` | none | `{ sandbox_id, deleted: true }` |

`create` requires a digest-pinned VCR image (`repository@sha256:<64 lowercase
hex>`), timeout between one minute and 24 hours, and 1/2/4/8 vCPUs. Account limits
may be lower. Always provide a stable `name` such as `fd-cloud-<environment-id>`
before invoking creation; a lost response must be reconciled by that name rather
than retried with a different billable identity. The adapter never calls
`getOrCreate` and never silently replaces a missing environment or snapshot.

`allowed_domains` is an explicit list of exact lowercase public DNS names.
Wildcards, IP literals, localhost/private names, and FalconDeck production hosts
are rejected. The configured model endpoint (default `https://api.openai.com/v1`)
must appear in it. Other daemon download domains must also appear, except for
the boot-only distributor described below. The provider policy denies all
other destinations and separately denies private/link-local/metadata subnets,
including IPv6. Startup DNS checks also reject private answers; the provider's
subnet deny rules remain the enforcement boundary after DNS changes. No private
Vercel network is attached and no production connectors are configured.

The existing release distributor has one boot-only exception:
`https://connect.falcondeck.com/dist/falcondeck-daemon-{x86_64,aarch64}-linux`.
Only the trusted prepare script executes while that hostname is temporarily
allowed; it downloads the exact configured URL with checksum verification and
no redirects. The hostname is removed from the policy before starting the
daemon or agent. This is a hostname allowance, **not** provider URL filtering.
An image with the preinstalled daemon avoids that exception altogether.

For a downloaded daemon, provide an explicit public HTTPS URL and SHA-256 digest.
Redirects are refused. Otherwise the image must supply the Linux executable at
`/usr/local/bin/falcondeck-daemon`. See [image/README.md](image/README.md) for the
unbuilt example tool image and opt-in test services.

## Source and result contract

Source is `{ files: [{ path, content_base64, executable }], tree_hash }`. The
camelCase aliases `contentBase64` and `treeHash` are accepted for the daemon's
shared source type. Every path is relative to `/workspace/project`; traversal,
symlinks, agent homes, credentials, Git internals, dependency directories and
build output are rejected. Source is checked at the transport and worker
boundaries. Limits are 10,000 files, 4 MiB per file and 32 MiB total bytes. No Git
credentials or original `.git` directory are uploaded. The worker initializes a
minimal Git repository and a synthetic baseline commit, including dirty source
bytes supplied by the source daemon.

The tree hash is SHA-256 of sorted UTF-8 records (byte lexical order):

```text
path + NUL + (executable ? "1" : "0") + NUL + sha256(file_bytes).lower_hex + "\n"
```

Export returns:

```text
{
  sandbox_id, version: 1,
  tree_hash, current_tree_hash,
  baseline_files: [{path, content_base64, executable}],
  current_files:  [{path, content_base64, executable}],
  deleted_paths: [path], binary_patch_base64,
  native_sessions: [{path, content_base64}], excluded_paths: [path]
}
```

It compares current files with the uploaded source, including work the agent
committed, and reconstructs a binary Git patch in a temporary clean repository
without executing the agent's Git hooks/config/filters. Current files have the
same limits as source. Native history contains only Codex rollout JSONL under
`.codex/sessions`, capped at 16 MiB/1,000 files, with recognizable inline
credential patterns redacted; auth files, logs, config, caches and token stores
are excluded. The binary patch is capped at 64 MiB and the CLI export at 256 MiB.
Worker command logs are bounded while streaming; oversized output kills the
command before the SDK can accumulate an unbounded result in the local helper.
Export during writes may fail and should be retried after the turn is idle.

The source daemon must verify the returned baseline against its locally retained
upload hash/bytes and verify the current hash. The agent has access to its own
worker filesystem, so a self-consistent worker manifest alone is insufficient.
Keep the local uploaded baseline authoritative. Applying any changes is a
separate explicit operation with conflict checks; this helper does not write
back to the source machine.

## Gateway, identity, and lifetime

Only port 3000 is exposed. It runs a small bearer-authenticated HTTP/WebSocket
gateway to the daemon bound at `127.0.0.1:4380`. HTTP accepts `/api/*` paths; WS
accepts `/api/events` and terminal WS paths. Tokens are random 256-bit
capabilities sent only as `Authorization: Bearer ...`, never query parameters.
The gateway strips authorization, cookies, proxy identity, and CORS headers
before passing requests to the fixed loopback upstream. The daemon and gateway
detach from the controller so closing the local helper does not kill a turn.

The worker gets a new task-local `HOME`, `CODEX_HOME`, daemon state and empty
connector/provider settings. Its environment is explicitly constructed: only
the supplied model API key is passed, with no provider account token, host
environment or copied login cache. Secrets are removed from bootstrap files as
soon as startup succeeds; a resumed environment requires the caller to supply
the model credential again and receives a new gateway token.
The model endpoint is pinned for the environment. A caller using a nondefault
endpoint must explicitly pass that same endpoint on resume; the workload's
retained native config is rewritten from the caller-controlled endpoint before
starting the daemon, so it cannot redirect a newly supplied credential.

The installed SDK's actual persistence model is filesystem snapshots, **not
process/RAM persistence**. Persistent stop automatically snapshots; restoring
requires restarting the daemon and gateway. The helper explicitly sets
`persistent: true`, `snapshotExpiration: 86400000` (24 hours) and
`keepLastSnapshots: {count:1,expiration:86400000,deleteEvicted:true}`. This replaces
the provider's 30-day default. Snapshot storage may be billable until deletion or
expiry. A provider timeout still ends compute when the source Mac is asleep;
there is no always-on lifecycle controller in this package.

Ordinary `stop` scrubs credential files and retains one bounded snapshot.
This remains true after verifying an export; the legacy `export_verified` field
does not destroy resume state. Only explicit `delete` removes the sandbox and
its unreferenced snapshots, permanently. Orphan snapshot deletion is asynchronous
in the SDK. Inspect and repeated stop of stopped environments
use metadata-only SDK reads and never spin up a session. Export requires a
running session; resume refuses when no current snapshot remains.
Confirmed SDK sandbox-metadata 404 responses make inspect/stop succeed with
`status: "deleted", deleted: true, missing: true`. Network errors, authorization
errors, missing snapshots, and command/session 404s remain reconciliation errors.
Known-session commands use the SDK's public `Session` API: unlike its `Sandbox`
convenience wrappers, these calls do not auto-resume when a deadline races them.
Resume updates the bounded timeout while the sandbox is stopped, before starting
its next session; it never relies on a client-only expiration estimate.

Official references: [SDK](https://vercel.com/docs/sandbox/sdk-reference),
[persistence](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence),
[custom images](https://vercel.com/docs/sandbox/concepts/images),
[firewall](https://vercel.com/docs/sandbox/concepts/firewall),
[published SDK](https://www.npmjs.com/package/@vercel/sandbox).
