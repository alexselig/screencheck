# Changelog

All notable changes to ScreenCheck are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). From 0.2.0 on, every
release is a `v<version>` tag that GitHub Actions publishes to npm with
provenance.

## [Unreleased]

### Added

- **Screen index thumbnails and a resizable rail.** A **Show thumbnails**
  switch (off by default) shows the top of each screen under its name; drag
  the rail's right edge (or use the arrow keys on it) to make the rail and its
  thumbnails wider, 220–640px. **Hide approved screens** moved from the rail
  head to sit with it at the bottom of the screen index. All three settings
  are remembered. Thumbnails are written at capture time (400 and 800px),
  made once in a Web Worker for older captures, cached on disk under
  `thumbs/` with a `GET`/`PUT /api/projects/:id/thumbnails/:version/:screen`
  route, and carried in offline bundles. `scripts/perf/rail-thumbnails.mjs`
  checks the performance budget on 120 screens.
- **AI assist (optional, off by default).** `screencheck serve --assist` (or
  `SCREENCHECK_ASSIST=1`) lets the reviewer's own GitHub Copilot CLI rewrite a
  note into an instruction for an agent, suggest a priority and tags, and
  summarise a round; a "possible duplicate of #N" hint uses local text
  similarity. The CLI runs tool-less with a timeout, needs no keys, and the UI
  hides itself when the CLI is missing. Suggestions apply only when accepted.
- **Open comments carry forward.** When a newer build of the same size has a
  capture of the screen, open comments move to it (no duplicates), re-anchored
  onto the element they were dropped on via the element maps. The record keeps
  `carriedFrom`; pins whose element moved or vanished get a dashed yellow ring
  and a **Check placement** label, cleared with **Placement OK**. New pins
  record their `element`.
- **All-sizes comments.** On a screen with several sizes the pin editor offers
  **This size / All sizes** (`scope`, absent means this size). An all-sizes
  comment is stored once and shows dashed on the other sizes and in Compare
  sizes, with "Pinned at 1440" on its card; the rail counts it once.
- `list_feedback`, `get_comment` and `reply --list --json` return `size`,
  `scope`, `carriedFrom` and `checkPlacement`; the plain `reply --list` line
  marks `(all sizes, check placement)`.

- **Before | After** toggle in the footer (and **B**): flips the canvas to the
  previous build's capture of the same screen and size. On phones it is in the
  **…** menu.
- `screencheck issues` files review comments as GitHub issues through `gh`, one
  per comment or `--per screen`, with the screen, size, priority, tags, note,
  thread, a link back and a saved crop around the pin. Re-runs skip comments
  already filed (the issue is stored on the comment as `issue`).
  `screencheck issues sync` moves comments whose issue was closed to Fixed,
  never to Verified.
- **Release gate:** `screencheck status --project <id>` reports a review
  round without a running server: screens and approvals (rolled up across
  sizes), open comments by priority, fixes not yet verified and what changed
  since the previous revision. `--gate` exits 1 while a P0 is open or a screen
  is unapproved (`--max-priority`, `--allow-unapproved`); `--json` prints a
  stable object. The MCP server gains a matching `release_status` tool.
- `screencheck capture --config <file>` captures every screen in a
  `screencheck.config.mjs` (or `.json`) at every viewport, with element maps,
  into one version per width sharing a revision, and writes or updates the
  project registration. `--version` sets the revision; `--screen <id>`
  re-captures one screen. Example in `examples/screencheck.config.mjs`.
- Versions in a registration may carry an explicit `viewport` width beside
  `revision` and `label`; it labels the version when there is no `label`.
- **Box pins:** while placing a pin, drag to draw a rectangle; a click still
  drops a point. Stored as an optional `box` (fractions of the capture) with
  `x`/`y` at its centre, so older files and point-only consumers are
  unaffected. The element map, `get_comment` crop and Markdown/agent exports
  use the region.
- **Reviewer names without accounts:** a name per browser, asked for inline
  in the feedback editor and editable from **Your name…** in the **…** menu.
  New comments and reviewer replies carry it as an optional `author` (≤ 60
  characters, control characters stripped); cards and threads show it with
  the time. `@agent` and `@name` in notes and replies render as chips, and MCP
  `list_feedback` takes a `mentions` filter. Older comments load unchanged.
- **Offline review bundles.** `screencheck bundle --project <id>` writes a
  `.screencheck.zip` with the captures, feedback, registration and a viewer
  that opens from `index.html` with no server. Reviewers add comments there
  and send them back with **Export review**; `screencheck import <file>`
  merges them, skipping any already present.

### Changed

- The size switcher and Compare sizes run widest first: **1440 Desktop · 768
  Tablet · 390 Phone**. Shift+← / Shift+→ follow that layout. While Compare
  sizes is on, its button carries an attached × that closes it.
- The caption, screenshot and Compare sizes row are left-aligned with the
  screen title at every size instead of centred.
- A screen approved at every size shows only its check in the screen index, now
  green with a white tick; the open count is hidden.
- The canvas toggles (size, zoom, Compare sizes) line up with the caption and
  share the Before | After look.
- The Markdown export groups comments by screen, then **All sizes**, then one
  heading per size, instead of by version first.
- The site's install steps show `capture --config` instead of a partial
  capture snippet, and name the **Viewport** filter correctly.
- **Responsive review.** Versions that share a `revision` are sizes of one
  build:
  - A size switcher above the capture (**390 Phone · 768 Tablet · 1440
    Desktop**), with **Shift+← / Shift+→** to step sizes. The size carries
    across screens and revisions and is kept in the address bar.
  - **Fit / 100%** zoom: fit the whole width, or actual pixels with a
    scrolling canvas. Pins scale with the capture.
  - **Compare sizes**: every size of the screen side by side at one height,
    with its pins. Click a size to open it; Esc returns.
  - **Approve all sizes**, with the same unverified-fixes check per size.
  - A version's numeric `viewport` is used as its width when present.

### Changed

- The screen index lists each screen once per build, not once per size: open
  badges count across sizes, and an outlined check marks a screen approved at
  some sizes but not all. **Hide approved screens** hides only screens approved
  at every size.
- The **Viewport** filter is gone; the size switcher replaces it. Shift+← / →
  now step sizes rather than screens (plain ← / → and [ / ] still step
  screens).
- Builds are never called "Resolution" anywhere in the UI or docs, and the
  footer counter and screen index numbers always agree, since each screen
  has one row.
- The playground captures build-42 at 390, 768 and 1440.

- **Hide approved screens** is a switch, and turning it on from an approved
  screen moves to the nearest screen still to review.
- The compact screen index has no pin button; the expand arrows keep it open.

### Fixed

- `capture` works when run through tsx (`npm run screencheck`); page
  functions no longer fail with `__name is not defined`.

## [0.2.0] - 2026-10-22

### Added

- A **Revision** picker in the header, newest first. Versions that share an
  explicit `revision` appear as one entry with a **Viewport** filter, and the
  screen index lists each screen once per viewport.
- **Hide approved screens** toggle in the screen index.
- ↑/↓ (and Home/End) step through the screen index.
- ⌘A / Ctrl+A toggles approval for the current screen.
- A seeded playground (`npm run playground`) and a feature walkthrough in
  `docs/PLAYGROUND.md`.
- `npm run smoke`: packs the tarball, installs it in a scratch app, checks
  `--version`, `serve` and `/healthz`, and type-checks
  `import "screencheck/capture"` under `nodenext`.
- CI on every push and pull request: type check, tests, build and smoke on
  Ubuntu, macOS and Windows with Node 22 and 24.
- README sections on versions, revisions and resolutions, every Esc context,
  the caption and tag keys, and `GET /healthz`; the project site gains the
  same keyboard table.
- `screencheck init` and `screencheck add` register a project from a folder of
  captures; `screencheck demo` runs the playground from the package.
- `screencheck capture` writes the element map and swaps images in atomically.
- `screencheck reply` gains filters, a thread view and `--json`; it accepts
  `done` as Fixed.
- `SCREENCHECK_HOME` moves all state with one variable.
- An empty state, with a starter registration, replaces the Example project.
- Keyboard pin placement (arrows, Enter) and **Comment on whole screen**.
- Roving tabindex in the screen index, and skip links to the capture and the
  feedback panel.
- Export chooses which versions to include.
- **Reopen** on Verified comments, with a required reason.
- Shared links open the version they name.
- This changelog.

### Changed

- Releases are tag-driven. `publish.yml` fails when the tag doesn't match
  `package.json`, refuses a non-dry-run manual run off a tag, pins npm, and
  runs the smoke test before publishing.
- `package-lock.json` resolves every package from `https://registry.npmjs.org/`
  with sha512 integrity; versions are unchanged.
- `npm test` only runs `tests/`, opens no HMR socket and skips Vite
  pre-bundling, so parallel runs and worktrees don't collide.
- Plans and specs moved from `docs/superpowers/` to `.github/plans/`, so the
  public site only serves the site.
- ROADMAP re-ranked: config-driven capture, an explicit revision × viewport
  model, carry-forward of open pins, the release gate, then compare.
- Version ids are no longer split on a trailing number: `build-41` and
  `build-42` are two revisions, not two resolutions.
- One server per data root: a second `serve` on the same data exits with a
  message naming the running one, and a busy port is explained.
- Approvals are reviewer-only on the server, and writes for unregistered
  projects, versions or screens get `404`.
- Captures revalidate by `ETag`, so a re-capture shows at once.
- The app and API send anti-framing and CORP headers.
- `sharp` is an optional peer, which cuts `npx` cold start.
- Esc undoes only the innermost thing; shortcuts go through one router.
- Prev/Next and ←/→ skip screens hidden by **Hide approved screens**.
- Error banners can be dismissed and clear when stale.
- Rail rows span the full rail width, with badges kept clear of the row edge.

### Fixed

- A pending note edit no longer saves onto the comment you switch to; edits
  flush before ⌘F, rail clicks, Prev/Next and ←/→.
- A failed status change rolls the picker back.
- Unknown fields in feedback records survive a rewrite, and one bad record no
  longer fails the whole file.
- File streams can't crash the server on a read error; malformed URLs get
  `4xx`, not `500`.
- The MCP/CLI conflict retry no longer overwrites a reviewer's newer status.
- A relative `capturePath` keeps its subfolders inside `captureRoot`.
- Directory fsync tolerates Windows; each store keeps a last-good backup.
- Focus lands somewhere useful after pin, card, verify, reply and delete
  actions, and Escape cancels the approve-anyway confirm.
- `screencheck/capture` now ships type declarations at the path `exports`
  points to, with `.js` extensions on relative imports, so `nodenext`
  consumers compile.
- The MCP server reports the `package.json` version instead of a hard-coded
  `0.1.0`.
- The site's social card uses an absolute `og:image` and adds `og:url` and
  `twitter:card`.

## [0.1.0] - 2026-10-09

First npm release: `npx screencheck` with `serve`, `mcp`, `reply` and
`capture`; the MCP server; element maps at capture time; threaded replies; and
the reviewer-only Verified status.

[Unreleased]: https://github.com/alexselig/screencheck/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/alexselig/screencheck/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/screencheck/v/0.1.0
