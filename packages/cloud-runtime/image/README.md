# Example cloud worker image

This image definition has **not** been built, published, or exercised in a paid
sandbox. It is a starting point for qualification. It contains Node 24.22.1,
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

## Manual build workflow

`.github/workflows/cloud-worker-image.yml` runs only through `workflow_dispatch`.
It builds the daemon with `cargo build --locked --release -p falcondeck-daemon`
on Ubuntu 22.04, avoiding a glibc newer than the Debian 12 runtime. It builds
the `with-daemon` image for `linux/amd64`, runs tool/version checks with network
access disabled, and uploads the daemon, its SHA-256, linked-library inventory,
and image build metadata as a seven-day GitHub Actions artifact. It does not
start the daemon server, Docker services, a sandbox, or a model request.

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
Image construction and these checks still require their first manual run.

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
public Vercel ports. Engine startup, pulls, service readiness, the Linux daemon,
and a real Codex turn still need a live integration smoke test before release.

Sources checked on 2026-10-30:

- [Vercel custom images](https://vercel.com/docs/sandbox/concepts/images)
- [VCR token login and Buildx publication](https://vercel.com/docs/container-registry)
- [Vercel Docker and elevated privilege support](https://vercel.com/sandbox)
- [Official Node image](https://github.com/nodejs/docker-node)
- [Official Docker image definitions](https://github.com/docker-library/docker)
- [Meilisearch releases](https://github.com/meilisearch/meilisearch/releases)
