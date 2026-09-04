# Inventory

Read this when building the inventory, before testing. The report checklist is the only denominator that counts.

## What a row is

One row = one reachable UI at one viewport under one auth/data setup.

Split a path into multiple rows when any of these change the screen:

- Viewport (if the user asked for more than one)
- Auth / plan / role (anonymous vs signed-in vs paid vs admin)
- Query or wizard state that swaps a whole panel (`?tab=`, `?mode=`, `?step=`, source pickers)
- Required context (entity id/slug, selected project, active record)
- Empty vs populated vs paywalled vs first-run, when those are distinct UIs

Do not split on tracking params, locale prefixes that render the same chrome, or theme unless the user asked for a theme matrix. Note the active theme in the report header and stay on it unless told otherwise.

## Extract declared routes

Search the frontend, then confirm against what the running app actually links to.

Typical places (use what this repo has; do not require all of them):

- React Router: `app/routes.ts`, `app/routes.tsx`, `frontend/app/routes.ts`, route modules under `app/routes/` or `app/pages/`
- File-based: `app/**/page.tsx`, `pages/**`, `src/routes/**`
- Laravel Blade / Inertia: `routes/web.php` plus the frontend page map
- Explicit path strings: `path:`, `Route`, `createBrowserRouter`, `href:` in nav config

For each declared path record:

| Field | What to capture |
| --- | --- |
| Path pattern | `/settings`, `/items/:slug` |
| Concrete URL | Fill params from fixtures, not `undefined` |
| Auth | anonymous / authed / role / plan / admin |
| Layout | marketing, app shell, modal, wizard step |
| Source | file path of the route module when known |

Skip API-only routes (`/api/*`, JSON resources) unless they render HTML.

## Add variants the router does not list

From product knowledge, the QA skill, and a first nav pass:

- Wizard/query variants that swap the main pane
- Seeded fixture URLs for context-required players (the project's documented QA records, not random live data)
- Signup vs login vs logged-in landing
- Logged-out visit to an authed path when that produces a distinct redirect or login wall
- Settings tabs, index filters, mode pickers, checkout plan states — only when they are distinct UIs

Prefer documented fixtures over generating new content. If generation/queues are idle in this environment, do not sit on a loading screen; use fixtures and log the environmental caveat once.

## Categorise

- **anonymous-only** — marketing, legal, login, register
- **authed** — default signed-in app
- **role/plan-gated** — needs a specific plan or role; name the test user
- **admin-only**
- **context-required** — needs an id/slug/fixture
- **destructive** — delete/cancel/purge; test on throwaway data or mark BLOCKED

## Nav spider (required)

After the static list exists, in the real browser:

1. Dismiss overlays.
2. Open every top-level nav, sidebar, footer, account menu, and in-page "see all" / CTA that looks like navigation.
3. Add any URL you land on that is missing from the list.
4. Note dead links (click → same page, 404, or unexpected redirect) as bugs, and still add the intended path as a row.

This is an inventory pass, not full testing. Do not deep-exercise page controls yet.

## Order of work

1. Auth bootstrap (login/signup only as needed to reach the rest)
2. Core user journey named in the product docs (create/use primary object → its player/editor → progress/settings)
3. Onboarding, paywalls, empty states
4. Secondary app surfaces
5. Admin, legal, 404, leftover marketing

If count > ~50, keep every row and only change order. Write the count in the report before row 1.

## Status values (inventory column)

Leave `status` empty until the per-route protocol finishes for that row.

| Status | Meaning |
| --- | --- |
| PASS | Protocol complete; no new P1. P2/P3 may still be logged. |
| FAIL | Protocol complete; at least one new P1, or a core interaction on this row is broken. |
| BLOCKED | Could not complete (auth, plan, missing fixture, environment). Reason required. |
| SKIPPED | Out of scope because the user excluded it. Reason required. |

`PARTIAL` is only for a crash/context stop on the current row. It is not a completion status.

## Do not

- Drop "boring" routes (legal, 404, empty index, account deletion).
- Collapse 8 settings tabs into one row if they are different pages.
- Treat a redirect as coverage of the destination — the destination is its own row.
- Inventory Laravel API endpoints as if they were screens.
---
