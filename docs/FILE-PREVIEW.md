# Opening local files from a phone

Bots and agents hand James things to review as links to files on the Mac:
reports, HTML dashboards, PDFs, screenshots. Paired clients read them through two
read-only daemon RPCs, `file.stat` and `file.read_range`
(`crates/falcondeck-daemon/src/file_preview.rs`, registered in `remote_bridge.rs`;
types in `falcondeck-core` and `client-core/src/types.ts`). They never write, list
or execute.

## Contract

Both calls take `path` plus optional `base_dir`, `workspace_id` and `thread_id`.
`path` may be absolute, `~/…`, a `file://` URL (query and fragment are dropped), or
relative. A relative path resolves against `base_dir` (a document's own folder, so
`../img/a.png` inside a report works), else against the thread's working directory.

- `file.stat` returns `FilePreviewMeta`: canonical `path`, `name`, `size_bytes`,
  `modified_ms`, `version` (`mtime:size`), `content_type`, `kind`
  (`markdown|html|pdf|image|video|audio|code|text|binary`), `max_range_bytes`.
- `file.read_range { offset, length, version?, compress? }` returns the same
  metadata plus `offset`, `length` (raw bytes covered), `eof`, `encoding`
  (`identity` or raw-`deflate`) and `data_base64`. A small file needs one call.
  `version` pins a multi-range read to one revision (`file_changed` otherwise).

Clients cache on canonical `path` + `version`.

Errors begin with a stable code: `file_denied`, `file_not_found`,
`file_too_large`, `file_changed`, `file_unsupported`. The text after the code is
safe to show.

## Limits (relay)

The relay carries about 70 KB/s and drops an RPC after 30 s, and payloads grow
roughly 2.4x on the wire. A range is therefore at most 256 KiB, files at most
25 MB. Never fetch a file in one call; stream ranges with progress. Text, HTML,
JSON and code ranges ask for `compress` (about 4x smaller); images and PDFs do not
compress. A 25 MB PDF takes minutes over the relay: show progress and keep reading
while the user waits.

## Access policy

Allowed roots, rebuilt per call:

| Root | Why |
| --- | --- |
| Registered project folders and every thread's working directory (isolated copies) | repo files, `~/.falcondeck/variants/<project>/…` |
| Each bot's `space_path` | STATUS.md, reports in `~/.falcondeck/bots/<id>/space` |
| `<state dir>/artifacts`, `context`, `variants`, `worktrees` | where agents publish work for review |
| `~/.local/share/codex-artifacts` | Codex's artifact folder (about 200 links in a week of transcripts) |
| `/tmp`, `/private/tmp`, the user temp dir | scratch reports and screenshots agents link by absolute path |

Roots that are `/`, the home directory or one of its ancestors are ignored.
Everything is canonicalised first, so `..` and symlinks that leave a root are
denied. A path that does not exist is "denied" outside the roots, so the reply is
not an oracle for the rest of the disk.

Denied even inside a root, judged on the requested and the canonical path:
`.env*`, `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.doppler`,
`.git` internals, `Keychains`, `*.pem *.key *.p12 *.pfx *.p8 *.jks *.keystore
*.keychain* *.ppk *.kdbx *.tfstate *.token`, `id_rsa*`/`id_ed25519*`/…,
`credentials*`, `secrets.*`, files named `secrets`/`token`/`auth.json`,
`.netrc .npmrc .pypirc .pgpass .htpasswd .git-credentials .dev.vars`,
`remote-secrets*`, `daemon-state*`, `service-account*`.

Not allowed on purpose: `$HOME` at large, `~/.cache`, `~/.claude`, `~/.config`,
`~/Downloads` and the rest of the state dir (`daemon-state.json`, secrets,
`attachments`). Adding a root means editing `file_preview_access`.

## Follow-ups

- `http://localhost:PORT` and `*.ts.net` links are not proxied. A daemon HTTP
  proxy over the relay (ranged GET, streaming) is roughly two days with tests.
