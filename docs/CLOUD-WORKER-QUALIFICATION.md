# Cloud worker qualification — 2026-10-30

Status: **locally qualified; unpublished; Vercel qualification pending**.

The retained OCI archive contains the real Linux amd64 daemon built from
`6d05b821` using pinned Rust 1.98 and the normal release profile, including thin
LTO. The bootstrap now omits the ignored `preferred_auth_method` setting;
API-key selection uses the explicit custom provider's `env_key` configuration.
No user credential was read for worker execution. A literal placeholder was
used with Docker networking disabled.

| Artifact | Value |
| --- | --- |
| Daemon SHA-256 | `4135ed395fd9f4320b631e5dc05da278131cb905e7a70a5407d6e7b93dd62d71` |
| OCI manifest digest | `sha256:2b9a141f272d202f30242bafed1d2cdfab63d058e4514442ecd33a0afce0ba41` |
| Archive SHA-256 | `248522f1fe21ea8586bc3cb683d2f1833689f84201d13dc9ae30d67f0cc2fc7d` |
| Archive size | 663,289,344 bytes (about 633 MiB) |
| Largest compressed layer | 187,491,269 bytes |
| Total compressed layers | 663,254,946 bytes |

The owner-only artifact directory outside Git contains the OCI archive,
checksums, ELF/linked-library inventory, build metadata, runtime source hashes,
smoke-test JSON and tool/version output. Temporary Docker resources are removed
when local preparation finishes. The archive is the requested deliverable.

## Passed locally

- The daemon is ELF x86-64 with the GNU amd64 interpreter, GLIBC requirements
  at or below Debian 12's 2.36, no missing runtime libraries, and a working
  `--version` probe inside the final image.
- The exact OCI archive was loaded and tested with networking disabled. Node
  24.22.1, Codex 0.166.0, pnpm 12.16.1, PHP 8.2.35, Composer 2.8.12, Docker
  28.5.1 and Compose 2.40.3 execute as the image's `node` user.
- Real worker preparation preserves captured bytes, executable modes and the
  synthetic Git baseline. The daemon and bearer-protected gateway detach and
  start successfully; unauthenticated requests are rejected.
- The real Codex app-server creates a native thread and returns its empty
  history. No turn is admitted, queued or completed. The check's request
  allowlist has no turn/completion endpoint.
- Real export handles edited, binary and deleted files, validates baseline and
  output hashes, excludes the fixture `.env`, and preserves the original index.
- Credential scrubbing, owned-process termination and scratch cleanup pass.
  All 38 cloud-runtime regression tests pass after the bootstrap cleanup.
- The existing Vercel CLI login successfully authenticates Docker to VCR using
  a short-lived project-scoped credential. Its temporary credential directory
  was removed; the normal Docker configuration was untouched.

## Remaining qualification

No registry push, paid sandbox, model request, production deployment or account
upgrade was performed. VCR optimization **Ready**, actual microVM boot,
provider stop/resume and native-session restoration remain untested. Real model
credentials and model turns are separate qualification work.

Docker test services were not started, and project dependencies/caches were not
installed. The PHP 8.2 tooling image is not a qualified Quizgecko PHP 8.4 test
image. Compose syntax/version checks do not establish service readiness.

After account/budget approval, use one fixed-name sandbox, one CPU/two GiB,
explicit deny-all egress and two explicit five-minute sessions to test boot and
cold restoration without model calls. Delete the sandbox and retained snapshot
at the end; uncertain admission must be reconciled before retrying.

The signed-in team is on Hobby. Vercel documents Hobby for personal,
noncommercial use; select an appropriate team for company workloads. Pro's
listed platform fee is $20/month with one seat and $20 usage credit. Ten minutes
at full CPU in `iad1` is about $0.0284 compute, plus registry/snapshot storage and
transfer. A $1 usage budget is a proposal, not authorization or a newly added
hard spending control.

Sources: [Hobby plan](https://vercel.com/docs/plans/hobby),
[Pro pricing](https://vercel.com/docs/plans/pro-plan),
[Sandbox rates](https://vercel.com/docs/sandbox/pricing),
[VCR limits and storage](https://vercel.com/docs/container-registry/limits-and-pricing),
[CLI registry authentication](https://vercel.com/docs/container-registry/cli-reference),
[Codex provider authentication](https://learn.chatgpt.com/docs/auth#alternative-model-providers).
