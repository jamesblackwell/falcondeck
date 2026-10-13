# FalconDeck documentation

Start with the guides below. Feature documents distinguish shipped behavior
from proposed follow-ups; research and dated reports record the state at the
time they were written.

## Use FalconDeck

- [Getting started](GETTING-STARTED.md): install, run a task, and pair a phone.
- [Keyboard shortcuts](16-keyboard-shortcuts.md).
- [Notifications and attention](NOTIFICATIONS.md).
- [Agent control and automations](AGENT-CONTROL.md).
- [MCP connectors](CONNECTORS.md).
- [Self-hosting the relay](SELF-HOSTING.md).

## Contribute

- [Contribution guide](../CONTRIBUTING.md).
- [Repository layout](10-repo-layout.md).
- [Design system](../DESIGN.md) and [Markdown rendering contract](MARKDOWN_STYLE.md).
- [Desktop development](../apps/desktop/README.md).
- [Mobile development](14-mobile-app.md).
- [Browser client](../apps/remote-web/README.md) and [public website](../apps/site/README.md).
- [Extension authoring](../extensions/AGENTS.md), [SDK](../packages/extension-sdk/README.md), and [test host](../packages/extension-testing/README.md).

## Implementation references

- [Agent adapters](ADAPTERS.md), [harness management](HARNESSES.md), and [harness conformance](HARNESS-CONFORMANCE.md).
- [ACP conformance](ACP-CONFORMANCE.md) and [Hermes tested behavior](HERMES-ACP-QUALIFICATION.md).
- [Extension platform](EXTENSIONS.md).
- [Conversation quality](15-conversation-quality.md) and [chat UI decisions](CHAT-UI.md).
- [Desktop file navigation and review](17-desktop-code-review.md).
- [Desktop dictation](18-desktop-dictation.md).
- [Computer use](COMPUTER-USE.md) and [in-app browser design](IN-APP-BROWSER.md).
- [Onboarding](ONBOARDING.md), [workspaces and isolation](WORKTREES.md), and [scheduled tasks](SCHEDULED_TASKS.md).

## Maintain and verify

- [Desktop updates and releases](13-desktop-updates.md).
- [Deployment with Ansible](../ops/ansible/README.md).
- [Relay diagnostics](relay-diagnostics.md) and [remote sync QA](remote-sync-qa.md).
- [Mobile reliability lab](../scripts/reliability/README.md) and [mobile profiling](../scripts/mobile-perf/README.md).
- [Bundled computer-use runtime](../scripts/cua-driver/README.md).
- [App Store listing](APP-STORE.md).

## Research and implementation history

These documents preserve rationale, proposals, and measurement evidence. Use
the implementation references above and the source code when checking current
behavior.

- Initial [architecture overview](00-architecture-overview.md), [architecture decisions](06-architecture-decisions.md), and [agent integration research](02-agent-integration-paths.md).
- [Platform direction](PLATFORM.md) and [provider research](PROVIDERS.md).
- [Agent control specification](agent-control-prd.md).
- [Cloud execution proposal](CLOUD-IMPLEMENTATION-PLAN.md) and [sandbox research](CLOUD-SANDBOXES.md).
- [Remote-host proposal](REMOTE-HOSTS.md) and [isolated-thread shipping design](ISOLATED-THREAD-SHIPPING.md).
- [Hermes integration plan](HERMES-INTEGRATION-PLAN.md) and [gateway qualification](HERMES-GATEWAY-QUALIFICATION.md).
- [Mobile sync plan](mobile-sync-responsiveness-plan.md) and [reliability lab plan](mobile-reliability-lab-plan.md).
- [Performance scan](performance-scan-2026-10-05.md), [installed startup measurements](installed-startup-performance-2026-10-06.md), and [mobile responsiveness](mobile-ui-responsiveness-2026-10-06.md).
- [Verified bug ledger](verified-bug-ledger.md).
- [Marketing and submission drafts](marketing/submissions/README.md).
