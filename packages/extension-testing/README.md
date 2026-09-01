# `@falcondeck/extension-testing`

The fake host exercises an extension through the same public SDK contract and
daemon-owned limits as FalconDeck. It never imports daemon or app internals.

```ts
import { createExtensionTestHost } from '@falcondeck/extension-testing'
import extension from '../server'

const host = createExtensionTestHost(extension, {
  extensionId: 'example.extension',
  declaredActions: ['refresh'],
  declaredViews: ['summary'],
})

const result = await host.invokeAction('refresh')
```

Pass the action and view ids from the fixture manifest so undeclared behavior
fails before a package reaches the real daemon. Failed actions roll private
storage and publications back atomically. `dispatchEvent` exercises public SDK
subscriptions with the same identifier-only payload and effect boundary;
`failNextAction` and `failNextEvent` support isolated host-failure tests, while
`storageSnapshot` and `diagnosticSnapshot` return detached JSON values for
assertions.

`invokeTool` exercises a declared `agentTools` entry the way the MCP bridge
does, with daemon-supplied thread and workspace context; it fails closed
without the `agent-tools:register` grant. Pass `declaredTools` and
`declaredSuggestionViews` from the fixture manifest so undeclared tools and
out-of-bounds composer suggestions fail here rather than at the daemon.

Pass `orchestrationRuns` plus the
`orchestration:manage-owned-tasks` grant to exercise owner-only run reads and
inspect the single returned `orchestrationEffects` reduction. The fake host
mirrors denial, revocation, JSON isolation, and the one-effect-per-callback
limit; lifecycle events may not return orchestration effects.

Pass `ownedAutomations` plus the `automations:manage-owned` grant to exercise
the generic owner-only Automation projection and inspect the single returned
`automationEffects` request. Tool invocations may include
`automationOwnerResourceId` as daemon-trusted provenance for a task created by
that extension's Automation. Lifecycle events may refresh projections but may
not return Automation effects.

`publishedViewSnapshot` exposes the latest successfully committed projection
per view and scope. The fake boundary also enforces the daemon's per-view,
retained-view-state, publication-count, action-input, storage, scope, and host
response limits.
