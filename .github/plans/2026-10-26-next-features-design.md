# Next features: responsive review first

October 2026. Draft for Alex's review; decisions marked **(decide)** are open.

## Why screen sizes come first

Sizes work today, but only by treating each size as its own version that shares
a `revision` with the others (`label: "390"`, `label: "1440"`). That gets data
in, but reviewing a responsive app is still awkward:

1. **Capturing is manual.** Three sizes means three capture runs and three
   hand-written version entries. `screencheck capture` takes one URL at one
   width.
2. **The index multiplies.** 9 screens at 3 sizes is 27 rows
   (`Sign in · 390`, `Sign in · 768`, `Sign in · 1440`). You can't see one
   screen's sizes together, only flip between rows.
3. **Feedback is split by size.** "The header wraps" filed on desktop is
   invisible on mobile. A cross-size issue has to be filed once per size, and
   the agent sees three unrelated comments.
4. **Approval is split by size.** Approving a screen means approving each size
   separately, and nothing tells you a screen is approved at 1440 but not 390.
5. **The canvas doesn't help you compare.** A 390px capture sits small in a
   wide canvas; a 1440px one is scaled down. There's no Fit / 100% choice and
   no way to see the sizes next to each other.

## Approaches

**A. Polish the current model (sizes stay separate rows).** Group each screen's
size rows under one heading with size chips. Cheap (S), but problems 3 and 4
remain, and the index is still three times longer.

**B. Make size an axis of a screen (recommended).** One index row per screen.
The size is chosen with a switcher on the canvas. Approvals roll up across
sizes, and a comment can apply to one size or to all of them. No new on-disk
version format: a size is still a version within a revision, with its `label`.
This fixes all five problems and reuses what 0.2.0 shipped. M–L in total, but
it ships in slices.

**C. One project per size.** Rejected: it splits approvals, exports and agent
queries across projects for no gain.

## Design (approach B)

### 1. Capture at several sizes (prerequisite, roadmap #6)

`screencheck capture --config screencheck.config.ts` lists each screen as a URL
with optional Playwright setup steps, plus `viewports: [390, 768, 1440]`. One
run captures every screen at every size with element maps, writes one version
per size into the same `revision` with `label` set to the width, and creates or
updates the registration. `--screen <id>` re-captures a single screen.

### 2. Screen index: one row per screen

- When the current revision has more than one size, the index lists each screen
  once. Its open-comment badge counts comments across all sizes.
- Approval mark: a full tick when every size is approved, a partial tick when
  some sizes are (tooltip: "Approved at 1440; 390 and 768 still to review").
- **Hide approved screens** hides only fully approved screens.
- The current Resolution/Viewport filter becomes the size switcher (section 3),
  so the index no longer changes length when you switch sizes.

### 3. Canvas: size switcher, zoom, compare

- A segmented control above the capture: **390 · 768 · 1440**, labelled
  Phone / Tablet / Desktop when the widths fall in those ranges. Shift+← and
  Shift+→ step between sizes (plain arrows and `[` / `]` step between
  screens; Shift+arrows currently do the same, so they are free to take). The
  choice persists while you move between screens.
- **Zoom:** Fit (default: the whole width fits the canvas) or 100% (actual
  pixels, scrolls). Pins scale with the capture, as they already do.
- **Compare sizes:** a view that shows every size of the current screen side
  by side, scaled to the same height, each with its pins. Read-only: you add
  pins in the single view. Clicking a size flips to that size; closing the
  view returns to the size you were on (decided by Alex).
- A device frame for phone captures is left out (YAGNI); revisit if asked.

### 4. Comments that cover every size

- New optional field `scope` on feedback: `"size"` (default; today's
  behaviour) or `"all"`. Existing data needs no migration.
- The pin editor gets a **This size / All sizes** choice. It defaults to the
  size being viewed (decided by Alex).
- An all-sizes comment is stored once, against the size it was pinned on. Other
  sizes show it as a dashed pin, placed by element-map match and falling back
  to the % position, with "Pinned at 1440" in its card. This uses the same
  re-anchoring as carrying pins forward (#8), so it is built once.
- Status, thread and verify are shared: fixing it once fixes it everywhere.

### 5. Approval across sizes

- Storage stays per version (per size). ⌘A toggles the current size, as today.
- The approval band adds **Approve all sizes**, which runs the same "fixes not
  verified" check for each size.
- Export and `approval_status` (MCP) report per-size approval and a rolled-up
  screen state.

### 6. Agents and export

- `list_feedback` and `get_comment` return the size label and `scope`; the
  crop comes from the size the pin was placed on.
- The Markdown export groups a screen's comments as All sizes, then by size.

## Feature order

0. **Before | After toggle in the footer** (high priority, per Alex). Flips the
   canvas to the previous build's capture of the same screen and size; **B**
   toggles; pins hide while Before shows. Shipped first, ahead of the full
   compare-builds work (#7), which later adds overlay and slider modes.
1. **Release 0.2.0** to npm (blocked on the npm token or Trusted Publisher).
2. **Leftover fixes:** don't label builds as "Resolution" (ux-3, ds-36); make
   counters match the index numbering (pr-10, ux-9); have `capture` write the
   element map and fix the site snippet (pr-11). S.
3. **Capture at several sizes** (section 1, roadmap #6). M.
4. **Responsive review, slice 1:** one row per screen, size switcher, Fit/100%
   zoom, approval rollup (sections 2, 3, 5). M.
5. **Responsive review, slice 2:** Compare sizes view. S.
6. **Responsive review, slice 3:** all-sizes comments, built together with
   **carry open pins forward** (#8) because both need element-map
   re-anchoring. M.
7. **Release gate** `screencheck status --gate`, including per-size approval
   (#10). S–M.
8. **Compare builds** (overlay, slider, "changed" dot; #7), then
   **before/after on every fix** (#9).
9. **Later, unchanged from ROADMAP.md:** box pins (#11), offline review
   bundles (#13), AI assist via CopilotBridge (#14), GitHub Issues sync (#15),
   suggested accessibility comments (#16), design reference (#17), reviewer
   names (#18).

## Testing

- Unit (vitest): size rollup for badges and approval, one-row-per-screen index,
  `scope` parsing with old records lacking it, dashed-pin placement from the
  element map with the % fallback.
- Component: switcher keys Shift+← / Shift+→, Fit/100%, Compare sizes opening a size,
  Approve all sizes blocked by an unverified fix.
- The playground seeds one revision at 390 / 768 / 1440 so every slice can be
  tried by hand, and the site screenshots gain a Compare sizes shot.
- Design-token tests apply to every new control.

## Open questions

None open. Decided: comments default to the size being viewed; Compare sizes
flips back to the current, or clicked, size.
