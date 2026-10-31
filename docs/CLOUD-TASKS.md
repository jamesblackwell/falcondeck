# Cloud execution prototype

Implemented as an opt-in prototype, with the ordinary conversation flow added 2026-10-31. Vercel Sandbox is the only provider. This supersedes the GitHub-input/PR-output assumptions in [the earlier pilot](CLOUD-JOBS-PILOT.md). Current working files are the input; PR creation, automatic landing and deployment are not required or enabled.

## What is built

- Native Mac and web desktop use the regular new-task composer: choose **Local** or **Cloud**, write the prompt, and send. Cloud conversations appear beside local conversations in their project's normal task list. There is no separate Cloud tasks destination. Provider setup stays in **Settings → Cloud execution**.
- The daemon owns automatic source capture, worker allocation, native identity and follow-up routing. Creating a cloud thread does not allocate compute. The first Send admits the worker; the ordinary task shows preparation, errors, native conversation items and approvals. A follow-up wakes the existing stopped environment when its retained state is available.
- Daemon-owned private configuration, immutable source captures, job identities, provider scope and collected native-session/result artifacts. No new conversation database.
- Current Git working-tree capture, including eligible staged, unstaged and untracked source, with the local Git index left unchanged. Known credential paths, private-key markers and common dependency/build trees are excluded; symlinks, Git LFS and submodules are rejected. The copy is frozen at creation, not continuously synchronized. Limits: 4 MiB per file, 32 MiB total, 10,000 files.
- One digest-pinned Linux environment per task. A real worker FalconDeck daemon owns Codex app-server. Provider credentials remain on the coordinator. Worker HTTP/WebSocket access requires its own bearer credential; the daemon itself stays on loopback.
- Follow-ups, native approval responses, interruption, automatic or explicit result collection and conflict-safe import. Import changes only the worker's delta and refuses affected local files that changed since the relevant baseline; it does not stage, commit or overwrite unrelated work.
- Stop/resume of the existing sandbox, with one private snapshot retained for up to 24 hours. Missing state never silently becomes a fresh task. Collected native history remains readable as a timestamped view artifact; live approvals cannot be answered from it.
- A manual-only Linux worker image build workflow. Its default is build-only. Optional VCR publication is explicit and does not deploy an application or start a model/sandbox.

The first runtime supports Codex API-key authentication. The normal HTTP and encrypted RPC creation contracts, including the in-session agent creation tool, accept the same cloud execution target. Claude/ACP cloud qualification, subscription sign-in, a mobile cloud creation picker, automatic main integration and production release orchestration remain follow-on work. Files, terminals and Git actions that would otherwise target the local checkout are disabled for a cloud conversation; changes return through explicit conflict-checked import.

## Unified thread contract

`thread.start` and `POST /api/workspaces/{workspace_id}/threads` accept `execution_target: "cloud"` and an optional stable `idempotency_key`. Omission keeps local behavior. Creation returns the normal `ThreadHandle`. The coordinator's stable thread ID is `cloud-<job UUID>`; native worker IDs remain private routing metadata. `ThreadSummary.execution_target` and `ThreadSummary.cloud` survive full and compact sidebar snapshots.

Use the ordinary thread detail, turn, interrupt, update, read, archive and approval paths for either execution target. Cloud lifecycle endpoints remain implementation support for contextual stop, collection and import; a client does not need a second conversation collection. A small in-memory projection forwards native cloud item and approval updates onto the existing daemon event stream. It stores no new conversation database.

The agent tool `falcondeck_create_thread` accepts `execution_target: "cloud"` too. Its usual project, parent, concurrency and permission checks still apply. Unsupported cloud providers, handoff modes or prompt attachments fail explicitly rather than executing on the local host.

## Setup

1. Install workspace dependencies with `npm install`. The adapter is `packages/cloud-runtime/src/cli.mjs`, requires Node 22+, and pins `@vercel/sandbox` 3.9.1.
2. Build the `with-daemon` image using the [manual workflow and image instructions](../packages/cloud-runtime/image/README.md). Publish to the intended VCR project, wait for `Ready`, and retain the digest. The image has passed offline local qualification; the workflow has not been dispatched. See [the qualification record](CLOUD-WORKER-QUALIFICATION.md).
3. In **Settings → Cloud execution**, enter team/project IDs, a scoped Vercel token, a separate model API key, the digest-pinned image and absolute adapter path on the coordinator. Leave worker download URL/checksum empty when the image includes the daemon. Secrets are write-only and stored in an owner-only coordinator file. Do not put them in Git or a chat.
4. Use a supported provider runtime limit: the account's own limits still apply. The provider-side deadline is real. **A per-job model dollar cap is not implemented**: the live pilot still needs an agreed budget and an appropriately constrained model credential/broker. Usage reporting alone is not enforcement.
5. Open a new task in the source project, choose **Cloud**, and send the prompt. FalconDeck captures eligible current files and prepares the environment. Review source exclusions and configure runtime secrets separately when needed. The prepared image has test tooling and private Docker Compose services; actual Quizgecko dependencies/cache priming and test commands must be qualified against its repository.

The coordinator is whichever daemon owns the selected project. It can run on the Mac for development or on an enrolled non-production Linux host. A remote coordinator captures projects present on that host; uploading a Mac capture to a separate coordinator is not yet implemented. There is no remote-to-local fallback.

Started workers are detached from the calling CLI and own their native processes. A configured always-on coordinator performs lifecycle work independently of the Mac UI. If the coordinator itself is offline, provider expiry is the fallback; do not promise early cleanup, phone starts or wake-up without an available coordinator. Local fake-process tests verify detachment and recovery plumbing; a real Vercel/Mac-restart journey remains unqualified.

Each coordinator admits one active compute-billed job at a time, including jobs whose allocation or stop outcome needs reconciliation. After a turn finishes, the online coordinator automatically collects results and stops compute; it makes up to three collection attempts before stopping with recovery state retained. The persistent workspace supports explicit resume from its retained snapshot for up to 24 hours while compute is stopped.

## Operator boundaries

Default egress is an explicit allowlist. Bootstrap constructs a fresh worker environment and does not automatically copy the coordinator's home, credential stores, SSH agent, local connector configuration or databases. Source exclusions recognize known secret paths and private-key markers; they cannot identify every secret embedded in otherwise eligible source. The capture inspection endpoint remains available for examining the inclusion/exclusion list without allocating compute. An optional verified daemon download temporarily allows its artifact host only during trusted bootstrap; access is removed before starting the agent. The preinstalled daemon image is preferred.

Never run deploys from these workers. Production release checks, immutable release artifacts, privileged credentials and irreversible-action approvals belong to a separate release runner. The worker image workflow is not that deployment pipeline.

A test-only Vercel account/project, model credential, image and cost/runtime budget are needed before live qualification. The initial implementation started no Vercel sandbox, cloud model request, image build/publication or production deployment. A subsequent local image build and offline qualification are recorded separately; publication and paid cloud execution remain pending. Global Vercel CLI/MCP onboarding was explicitly requested and verified separately.

## Checks and qualification

Local checks cover source/index preservation, conflict handling, wire hashes, private storage, durable admission, scope pinning, native worker HTTP flow, secret redaction, gateway authentication and limits, detached fake daemons, SDK lifecycle semantics, native UI compilation and web UI/API owner routing. The subsequent local image check establishes Linux binary compatibility and real daemon/Codex startup inside Docker. These checks do not establish real Vercel account quotas, microVM boot, model authentication or cost.

Before enabling a week-long pilot, run a bounded live task, interrupt/reconnect it across a Mac restart, collect/import its changes, stop/resume its exact native session, verify denied access, and measure all-in cost and startup time. Do not substitute mocked test results for these checks.
