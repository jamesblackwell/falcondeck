# Per-route protocol

Read before the first inventory row. Every row uses this sequence. Do not reorder. Do not skip the design-review step because the page "looks fine".

## PASS bar

A row is complete only when all of these are true:

- Viewport matches the row
- Full-page screenshot saved and linked
- `overflowX` recorded (`document.documentElement.scrollWidth - innerWidth`)
- Console errors/warnings recorded; new vs known called out
- Interaction checklist written from `snapshot -i` (or equivalent) **before** clicking
- Every listed interaction is tested or skipped with a reason
- Design-review notes exist (including "no anomalies")
- Route results line appended
- Todo for this row updated

Screenshot-only loads fail the bar even if the page rendered.

## Shared chrome

Global cookie banner, nav, footer, account menu, command palette, and theme switcher:

- First encounter: full protocol (every control).
- Later rows: only check that chrome does not clip, overlay, or overflow **this** page. Do not re-log the same global bug. Do log page-specific collisions.

Dismiss consent/NPS/promo overlays before measuring overflow or clicking page content. If an overlay is the bug, screenshot it first.

## Sequence

### 1. Navigate

- Re-snapshot after load. Wait on a concrete heading, test id, or app-state hook — not a sleep.
- Capture a full screenshot: `qa-artifacts/<run-id>/<nn>-<slug>.png`
- Overflow:

```text
document.documentElement.scrollWidth - window.innerWidth
```

Any value > 0 is a finding unless the page is an intentional horizontal scroller (carousel with an affordance). Screenshot the overflow.

- Console: record new exceptions. Do not re-log known benign noise from the project QA skill (CSRF 419 on anonymous loads, third-party FedCM, etc.).

### 2. Inventory interactions

From an interactive snapshot, list every actionable control on this row:

- Links, buttons, icon buttons, tabs, pills
- Inputs, textareas, selects, comboboxes, date pickers
- Checkboxes, radios, switches (include the visible label, not just the input)
- Menus, submenus, account drawers
- Modals, sheets, popovers, tooltips that have a trigger
- Drag targets, sliders, pagination, infinite scrollers
- File pickers, audio/video players
- Disabled controls (assert they stay disabled until the enabling condition)

Write them as a checklist under the route in the report **before** the first click. If the snapshot is incomplete (virtualized list, offscreen), scroll and re-snapshot until the list is honest.

### 3. Design review first

Judge against the project's design skill/tokens, then as a design lead. Look for:

- Corner radius off the documented scale, or mixed radii on sibling controls
- Off-token colors, hardcoded hex, wrong emphasis on the primary CTA
- Spacing/alignment that breaks the page grid; uneven padding in a row of cards
- Overlap, clip, sticky chrome covering content or focus
- Truncation with no tooltip, wrap, or expand
- Touch targets under ~44px on narrow viewports
- Hover-only affordances on narrow viewports; missing hover/focus on wide
- z-index mistakes (dropdown behind header, modal under banner)
- Inconsistent icon set or stroke width in one toolbar
- Broken empty, loading, error, and success states
- Text overflow in tabs, pills, and table first columns
- Form controls smaller than 16px text on narrow viewports (mobile zoom)

Note UI findings even when the flow works. Screenshot non-obvious ones. P3 is for polish; still log it.

Wait for advertised enter/exit animations to settle before calling layout broken. Screenshot twice if the first frame looks wrong.

### 4. Exercise every interaction

Re-snapshot before every click/fill. Refs go stale after any DOM change.

For each checklist item:

1. Scroll it into view. A reported click on an offscreen control is not a real click — verify the expected URL, network, or text change.
2. Perform the action the way a user would (label for custom radios/checkboxes if the input ignores clicks).
3. Assert the outcome. If nothing visible happens, wait on concrete state, then log a bug if it still no-ops.
4. Return to a known state before the next item when the action navigated away or opened a modal (close/back).

Required coverage:

- **Forms:** valid submit (happy path) and one invalid submit (empty, malformed, or too-long — whichever the field implies).
- **Wizards:** forward, back, and disabled Continue until valid.
- **Modals/sheets:** open, scroll body at this viewport, close via the advertised close control and via outside/Escape if those are claimed.
- **Tabs:** each tab's panel, not just the first.
- **Menus:** each item; wait out stagger animations.
- **Lists:** at least one row action and the empty state if you can reach it without destroying fixtures.
- **Players/editors:** one full happy path through the primary control set for this row, plus one failure (invalid input, validation, denied permission).
- **Destructive controls:** throwaway entity, or BLOCKED with why. Do not delete shared fixtures.

If a control cannot be reached (paywall, missing data), record it skipped on this row and, if a different inventory row was supposed to cover it, leave that row pending.

### 5. Log and close the row

- New bugs: next ID, screenshot, self-contained repro. Template in [report.md](report.md).
- Known bugs hit again: add "Re-verified YYYY-MM-DD" under the existing ID; do not mint B-new.
- Route results line: path, viewport, status, interactions tested vs found, overflowX, screenshot names, console summary.
- Update Resume to the next empty-status row.
- Mark the todo complete (or blocked).

Then start the next row. Do not summarize the whole audit until the completion gate.

## Failure-path minimum

If the row has no form, still include one negative: a disabled button that must stay disabled, a 404/empty state, a permission deny, or a network/validation error you can trigger safely. Rows with zero negative coverage need a one-line reason ("display-only legal page").

## Do not

- Click only the primary CTA and declare PASS
- Use sleeps instead of state waits
- Reuse stale snapshot refs
- Test hover-only on a narrow viewport and call that viewport done
- Expand scope into code fixes when a visual bug is obvious
---
