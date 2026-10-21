# Changelog

All notable changes to ScreenCheck are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). From 0.2.0 on, every
release is a `v<version>` tag that GitHub Actions publishes to npm with
provenance.

## [Unreleased]

## [0.2.0] - 2026-10-21

### Added

- The screen index lists every screen at every version of the chosen revision,
  with a **Resolution** filter and a **Revision** picker in the header.
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
- Rail rows span the full rail width, with badges kept clear of the row edge.

### Fixed

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
