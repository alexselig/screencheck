# Changelog

All notable changes to ScreenCheck are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). From 0.2.0 on, every
release is a `v<version>` tag that GitHub Actions publishes to npm with
provenance.

## [Unreleased]

## [0.2.0] - 2026-10-21

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
