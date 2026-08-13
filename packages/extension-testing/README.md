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

`publishedViewSnapshot` exposes the latest successfully committed projection
per view and scope. The fake boundary also enforces the daemon's per-view,
retained-view-state, publication-count, action-input, storage, scope, and host
response limits.
