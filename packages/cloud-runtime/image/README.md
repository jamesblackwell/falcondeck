# Cloud worker image

The `with-daemon` image was built and locally qualified on 2026-10-30 from
daemon source `6d05b821`, with the bootstrap configuration cleanup recorded in
this change. It has **not** been published or exercised in Vercel. See the
[qualification record](../../../docs/CLOUD-WORKER-QUALIFICATION.md). It contains Node 24.22.1,
Codex 0.166.0, pnpm 12.16.1, PHP 8.2, Composer 2.8.12, Git, and Docker 28.5.1
with Compose. Image references use immutable official registry digests, and apt
uses a dated Debian package snapshot. Refresh those pins deliberately for
security updates.

Build from this directory's narrow context so local project files and secrets
cannot enter the image:

```sh
docker build --platform linux/amd64 \
  --target runtime -t falcondeck-cloud-worker:example packages/cloud-runtime/image
```

Run that command only when a local build is wanted. No build or image publication
is part of the adapter tests. After reviewing and qualifying the image, publish
it to the intended Vercel Container Registry project through the normal VCR
workflow, wait for its `Ready` state, and configure the cloud connection with
its VCR reference **including its digest**. The Docker Hub references in this
Dockerfile are build inputs; `Sandbox.create({ image })` resolves VCR images.

Vercel requires an optimized `linux/amd64` image. It ignores Docker `ENTRYPOINT`
and `CMD`, and honors `WORKDIR`. The adapter explicitly starts its worker after
creation. The default image user is `node` (UID 1000), with passwordless sudo;
`/workspace` and `/opt/falcondeck-cloud` belong to that user. The `runtime`
target has no daemon: the adapter downloads an explicitly
configured HTTPS Linux FalconDeck daemon artifact and verifies its SHA-256
before execution. The `with-daemon` target instead copies the single prepared
`daemon/falcondeck-daemon` executable to `/usr/local/bin/falcondeck-daemon`,
which is the preferred production path. Both targets contain no provider
credential, native agent login, host identity, or connector.

## Local Linux build and qualification

Start from a clean checkout of the intended commit. The daemon build context
whitelists Rust sources and embedded extension assets; it excludes local homes,
Git metadata, dependency directories and environment files. A pinned Rust 1.98
builder runs on the local machine's native CPU and cross-compiles the daemon
for Linux amd64, using two Cargo jobs and the normal release profile. The final
worker remains Linux amd64 even on an Apple Silicon Mac.

Use an explicitly local Buildx builder. For example, on OrbStack:

```sh
docker buildx create --name fd-cloud-local --driver docker-container \
  --driver-opt memory=3g --driver-opt cpu-period=100000 \
  --driver-opt cpu-quota=200000 orbstack

docker buildx build --builder fd-cloud-local --platform linux/amd64 \
  --file packages/cloud-runtime/image/Dockerfile.daemon --target artifact \
  --output type=local,dest=packages/cloud-runtime/image/daemon .

docker buildx build --builder fd-cloud-local --platform linux/amd64 \
  --target with-daemon --load --tag falcondeck-cloud-worker:local \
  packages/cloud-runtime/image

docker run --rm --init --platform linux/amd64 --network none \
  --memory 2g --cpus 2 \
  --mount "type=bind,src=$PWD/packages/cloud-runtime/src,dst=/qualification/runtime,readonly" \
  --mount "type=bind,src=$PWD/packages/cloud-runtime/image/qualify.mjs,dst=/qualification/qualify.mjs,readonly" \
  falcondeck-cloud-worker:local node /qualification/qualify.mjs
```

The build exports the ELF binary, SHA-256 and its ELF/library-version inventory.
It checks the amd64 interpreter and requires GLIBC at or below Debian 12's 2.36.
The image must still pass `ldd` and execute its version probe in the final
runtime. The smoke script uses the real daemon and Codex executable, a placeholder
key, and an interface check requiring Docker's network-none isolation. It tests
actual detached processes, authenticated gateway access, an empty native thread,
source/export hashes, binary/deleted files, index preservation and cleanup. It
never submits a turn. Its JSON report explicitly distinguishes local checks
from untested model, Vercel and snapshot behavior.

To retain a publishable artifact without leaving Docker build caches, export
an OCI archive using the same local builder and image target:

```sh
docker buildx build --builder fd-cloud-local --platform linux/amd64 \
  --target with-daemon --provenance=false \
  --output type=oci,name=falcondeck-cloud-worker:local,dest=worker-linux-amd64.oci.tar,compression=zstd,compression-level=3,force-compression=true \
  packages/cloud-runtime/image
```

Load and qualify that exact archive before publication. Remove only the local
builder, containers and image tags created for this work; retain the requested
archive and its checksums/report. Leave shared images and caches alone.

## Publication using an existing CLI login

For local publication, the current Vercel CLI supports a project-scoped,
12-hour OIDC registry login through the existing sign-in:

```sh
vercel vcr login docker --project PROJECT_ID --scope TEAM_SLUG
```

The CLI passes the credential directly to Docker. Do not extract a token or put
it in argv, build arguments, layers or logs. This registry authentication does
not configure the FalconDeck coordinator's separate sandbox/model credentials.
Publication and live sandbox creation need an approved account and budget.
Hobby is documented for personal, noncommercial use; choose an appropriate team
for company work. A registry push alone does not prove VCR optimization reached
**Ready** or that the image can boot in a Vercel microVM.

## Manual build workflow

`.github/workflows/cloud-worker-image.yml` runs only through `workflow_dispatch`.
It builds the daemon with `cargo build --locked --release -p falcondeck-daemon`
on Ubuntu 22.04, avoiding a glibc newer than the Debian 12 runtime. It builds
the `with-daemon` image for `linux/amd64`, runs tool/version checks with network
access disabled, and uploads the daemon, its SHA-256, linked-library inventory,
image build metadata and the local qualification report as a seven-day GitHub
Actions artifact. It also runs the isolated local qualification script with the real daemon
and an empty Codex thread. It does not start Docker services, a Vercel sandbox,
or a model turn.

To run build-only, open **Actions → Build cloud worker image → Run workflow**,
select the intended revision, and leave `publish` unchecked. This needs no
Vercel or model secrets. The built container exists only on the CI runner; the
artifact contains the daemon and metadata, not a container-image archive.

To publish after reviewing the revision and build:

1. Set repository secret `VERCEL_TOKEN` to an access token authorized for the
   intended Vercel team/project. Set repository variable `VERCEL_TEAM_ID` to
   the owning team's ID (`team_…`, not its URL slug). No project-ID secret is
   needed for direct Docker registry authentication.
2. Manually run the workflow with `publish` checked and `registry_repository`
   set to `vcr.vercel.com/<team-slug>/<project-name>/<repository>`, without a
   tag or digest. The team slug and project name must identify that team and
   project; repository names are lowercase registry-safe segments.
3. The workflow logs in via `--password-stdin`, pushes a commit-SHA tag using
   VCR's recommended zstd/OCI exporter, and removes its temporary Docker
   credential file. It never forwards that token into a build argument,
   image layer, daemon, sandbox, or model environment. Pushing may create a
   private VCR repository and incur registry storage usage.
4. Read the image digest from the run summary/artifact, wait for VCR state
   **Ready**, then configure the cloud connection with the exact
   `vcr.vercel.com/<team-slug>/<project-name>/<repository>@sha256:<digest>`.
   Starting a paid sandbox remains a separate explicit operation.

Vercel also supports and recommends GitHub OIDC registry login for teams that
configure it; this initial workflow uses the documented token-login path. Do
not add any model API key or desktop signing/deployment secret to this workflow.
Local construction and startup checks have passed. The GitHub workflow itself
has not been dispatched; VCR publication, optimization and cloud boot remain
unqualified.

## Disposable test dependencies

Docker is installed but stays stopped until explicitly requested. Vercel supports
elevated privileges inside the sandbox VM, including Docker. The helper starts
an isolated Unix-socket engine with an empty environment, no TCP listener, and a
`vfs` store under `/run/falcondeck-docker`. It does not bind a host Docker socket.
Engine storage is session-local. The test Compose network is internal, all
published ports bind VM loopback, and service data uses tmpfs.

Inside a qualified sandbox, explicitly opt into the services when a project's
tests need them:

```sh
falcondeck-start-test-docker
export DOCKER_HOST=unix:///run/falcondeck-docker/docker.sock
docker compose -f /opt/falcondeck-cloud/compose.test.yml --profile tests up -d --wait
# Run the project's tests with its ordinary database/search configuration.
docker compose -f /opt/falcondeck-cloud/compose.test.yml --profile tests down --volumes
```

Postgres is `127.0.0.1:5432`, database/user `falcondeck_test`, password
`test-only-not-a-secret`. Redis is `127.0.0.1:6379`. Meilisearch is
`127.0.0.1:7700`, master key `test-only-not-a-secret`. These public literal values
are deliberately test-only and must never be used for production services.

The create request's deny-by-default egress policy still applies. Service image
pulls need explicitly approved registry/auth/CDN domains or preloaded images;
this example does not widen the firewall. Compose services are not additional
public Vercel ports. Engine startup, pulls, service readiness and a real Codex turn still need
qualification before release. The Linux daemon and an empty native Codex thread
have passed the offline local image check. PHP 8.2 and the generic test-service
recipe do not establish compatibility with Quizgecko's PHP 8.4 stack or warm
its project dependencies/package caches.

Sources checked on 2026-10-30:

- [Vercel custom images](https://vercel.com/docs/sandbox/concepts/images)
- [VCR token login and Buildx publication](https://vercel.com/docs/container-registry)
- [Vercel Docker and elevated privilege support](https://vercel.com/sandbox)
- [Official Node image](https://github.com/nodejs/docker-node)
- [Official Docker image definitions](https://github.com/docker-library/docker)
- [Meilisearch releases](https://github.com/meilisearch/meilisearch/releases)

- [CLI registry authentication](https://vercel.com/docs/container-registry/cli-reference)
- [Hobby plan scope](https://vercel.com/docs/plans/hobby)
