# Browser setup

Read during bootstrap. Prefer the project's `automated-qa-testing` (or equivalent) over this file when they conflict. This is the generic fallback.

## Driver

Default to the project's documented UI driver. That is usually the `agent-browser` CLI (snapshots, screenshots, console, eval, sessions). Use Playwright only when the project skill says so, or when you need a replayable assertion script — not as the spider itself.

One session for the whole run:

```bash
agent-browser --session qaspider set viewport <W> <H>
agent-browser --session qaspider open "<origin>/"
```

If the user asked for multiple viewports, change viewport on that same session when you switch rows. Do not open a second session per route.

Read current CLI help once if commands fail (`agent-browser --help`, `agent-browser skills get core`). Do not invent flags.

## Stack

Discover origins from `AGENTS.md`, compose files, or the project QA skill. A common local pair is:

- Frontend: `http://localhost:5173`
- API health: `http://localhost:8000/health`

Confirm before using. Start the documented dev command only if health checks fail. Wait for HTTP 200.

If the API is up but a background worker/queue is not, do not treat endless "generating…" as a new product P1 on every row. Log the environmental caveat once, use seeded fixtures, and only log UI bugs that remain valid when the worker is down (no timeout, no escape, lying readiness flags).

## Auth

- Same origin for impersonation and the app you will browse. Do not hit the API host in the browser for HTML.
- Prefer `/local-login` (or the project's impersonation URL) with a documented test user. Manual email/password only when testing those forms.
- After login, assert `get url` is still the QA origin and that a user hook / account menu shows the expected account.
- Plan limits: if a free account caps a feature, use the documented paid fixture for those rows instead of generating extra records.
- Signup: unique throwaway identity, never a shared inbox.

Do not reset shared billing/user seeds as a preflight.

## Anti-flake

- Re-snapshot before every click/fill. Refs are not stable across React re-renders.
- Wait on concrete UI or `eval` of app state, not `sleep`.
- Scroll the target into view; confirm the expected navigation or network after click.
- Re-snapshot after filling fields — submit buttons often enable only after validation.
- Custom radios/checkboxes: click the label, or the project's QA debug helper if it has one, when the input ignores synthetic clicks.
- Offscreen virtualized rows: scroll, then snapshot again.
- URL asserts: "starts with" after redirects, not exact equality when the app appends query.
- Cookie/consent banners overlay controls — dismiss first.
- If Chrome fails with sandbox/CDP errors, retry with the project-documented `AGENT_BROWSER_ARGS` (often `--no-sandbox`) before debugging the app.

## Evidence commands (agent-browser)

```bash
agent-browser --session qaspider snapshot -i
agent-browser --session qaspider screenshot qa-artifacts/<run-id>/<file>.png
agent-browser --session qaspider get url
agent-browser --session qaspider console
agent-browser --session qaspider errors
agent-browser --session qaspider eval "document.documentElement.scrollWidth - window.innerWidth"
```

Use `eval` for input values and app debug hooks. Do not trust `get value` on stale refs.

## When the driver is not agent-browser

Map the same protocol onto whatever the project uses (Playwright MCP, cua-driver, iOS simulator). You still need: persistent session, settable viewport, interactive element list, screenshots on disk, console/error access. If a capability is missing, say so in Resume and still complete the rest of the protocol.
---
