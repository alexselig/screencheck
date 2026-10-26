# ScreenCheck

A localhost-only Bauhausian workbench for reviewing live application screens
and versioned captures with durable pin feedback.

The repository contains generic tooling and example data only. Project source,
captures, injected headers, feedback, and identities live in ignored local
configuration under `~/.screencheck`.

> **Renamed from Screen Review Workbench.** Existing data keeps working: if
> `~/.screencheck` does not exist yet, ScreenCheck reads
> `~/.screen-review-workbench`. To move it, stop the server and run
> `mv ~/.screen-review-workbench ~/.screencheck`. The old `SCREEN_REVIEW_DATA`,
> `SCREEN_REVIEW_PROJECTS` and `SCREEN_REVIEW_URL` variables still work, and
> unsaved drafts and panel settings in the browser carry over automatically.

**Site:** https://screencheck.dev/ (feature tour
with screenshots).

## Install / Run

```bash
npx screencheck serve --open
```

To look around first, `npx screencheck demo --open` starts it on a seeded
sample project: a made-up ferry booking app in two builds with comments in
every state. It needs no Playwright or captures of your own, keeps its data in
`~/.screencheck-demo` (`--reset` starts over, `SCREENCHECK_DEMO_HOME` moves it)
and isn't recorded as your running server. It prints the `reply --url` command
and an MCP config pointing at itself, and
[docs/PLAYGROUND.md](docs/PLAYGROUND.md) walks through each feature.

Or install it once so `screencheck` is on your PATH:

```bash
npm install -g screencheck
screencheck serve --open
```

The server binds to `http://127.0.0.1:4173` (`--port` to change it) and
records itself in `~/.screencheck/server.json`, so the other commands find it
without a port. Throwaway servers (demos, scripts) can set `SCREENCHECK_RECORD=0`
so they don't take that slot from your real one. Node 22 or later.

If ScreenCheck is already running, `serve` prints where (`ScreenCheck is
already running at … (pid N)`) and exits 0, opening it with `--open`. If the
port belongs to some other program it says so; `--port 0` picks any free port.
Set `SCREENCHECK_HOME` to move all state at once — `feedback/`, `projects/`
and `server.json` — for a sandboxed trial, a test run or CI.

| Command                                              | What it does                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `screencheck serve [--port 4173] [--open]`           | Start the review server                                          |
| `screencheck demo [--port 0] [--reset] [--open]`     | Try it on a seeded sample project                                |
| `screencheck status`                                 | Print the running server's origin, or "not running"              |
| `screencheck init <id> --captures <dir>`             | Register a project from a folder of captures (see below)         |
| `screencheck add <id> <dir>`                         | Add a folder of captures as a new version                        |
| `screencheck reply --project <id> ...`               | List open comments or reply to one (see below)                   |
| `screencheck bundle --project <id> [--version <id>]` | Zip captures and feedback for an offline review (see below)      |
| `screencheck import <review.json>`                   | Merge comments exported from an offline bundle                   |
| `screencheck mcp [--url <origin>] [--author <name>]` | Run the MCP server on stdio for coding agents                    |
| `screencheck capture <url> --out <file>`             | Full-page screenshot without mid-page footers (needs Playwright) |
| `screencheck doctor [<project>] [--restore]`         | Check stored feedback; restore a damaged file from its backup    |

`screencheck --help` lists them; `screencheck <command> --help` shows options.

### Develop

```bash
npm install
npm run dev     # Vite with HMR on http://127.0.0.1:4173
npm test        # vitest, only the suites under tests/
npm run build   # dist/client plus the bundled CLI in dist/cli.js
npm run smoke   # after build: pack the tarball, run its CLI, type-check screencheck/capture
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build and the smoke
test on every push to main and every pull request, on Node 22 and 24 across
Linux, macOS and Windows. `package-lock.json` must resolve from
`https://registry.npmjs.org/`; a test fails if another registry appears in it,
so regenerate it with `--registry=https://registry.npmjs.org/` if you install
through a mirror.

Releases are tag-driven: bump `version` in `package.json`, add a
`CHANGELOG.md` entry, then push a `v<version>` tag. `publish.yml` refuses a tag
that doesn't match `package.json` and publishes with provenance.

### Playground

```bash
npm run playground   # seeded demo on http://127.0.0.1:4299
```

Captures a made-up ferry booking app in two builds, seeds feedback in every
state and opens the browser. It is the same scenario as `screencheck demo`,
rendered live with the dev server; the scenario lives in `scripts/playground/scenario.mjs`, and
`node scripts/demo/build-assets.mjs` re-renders the captures bundled in
`demo/` after changing it. [docs/PLAYGROUND.md](docs/PLAYGROUND.md) walks
through each feature, from dropping a pin to an agent replying over MCP.

## Current implementation

- Wide and compact numbered navigation with hover/focus expansion; the expand
  arrows keep it open. Between 901 and 1200px the index opens compact to give
  the capture room. Its title, collapse control and filter stay in view while
  the list scrolls.
- Fullscreen review: a slim numbered screen strip on the left that expands to
  names on hover (the chevron in its corner keeps it expanded), and a feedback
  handle on the right that shows the screen's open count.
- Stable screen manifests, registered from local JSON files.
- Screen pins placed on an aspect-locked screen frame, so they stay put at any
  window size. Each comment card leads with the same numbered dot as its pin.
  Pins scale with the capture (20 to 30px) and keep a 44px target. While
  adding, the frame gets a blue outline and a strip above it names the pin the
  click will place.
- Free-text tags with suggested P0/P1/P2 priorities (one at a time; new pins
  default to P1), a status of Backlog, In progress, Fixed, Verified or
  Won't fix, autosaved notes and two-step delete. Fixed pins turn teal with a
  check badge and Verified pins are solid teal, so new feedback stands out from
  what has already been addressed.
- **Threads close the loop.** Each comment keeps an ordered thread of messages
  from the agent and the reviewer. Whoever fixes a comment (usually an agent)
  replies with what was done, or why not, and can set its status in the same
  call. The collapsed card shows the latest message; the editor shows the whole
  thread, each message with its author, time and any status change it made,
  plus a **Reply** box for the reviewer. Closing a comment as Fixed or Won't fix
  from the editor needs a reply. Threads appear in exports in order.
- **Verify step.** A Fixed card shows **Verify** and **Reopen**; a Verified
  card shows **Reopen**. Verify moves it to Verified; Reopen moves it back to
  Backlog and needs a reason, which is added to the thread. Only a person sets Verified: the server refuses it unless the
  request carries `x-screencheck-actor: reviewer`, which the browser sends and
  agents do not.
- **Export** in the action bar opens a dialog: Markdown or JSON, all screens or
  this screen only, and which statuses to include. When the rail lists several
  versions, a Version choice covers all of them (the default, grouped under a
  heading per version) or just the current one. Exports are deterministic,
  state their scope, and keep on-screen pin numbers.
- The feedback panel chunks comments by status, then by priority. Empty chunks
  are hidden and untagged comments sit under their status with no heading.
  A card being edited stays where it is while you type, even after autosave,
  retagging or a status change; it moves to its new group when collapsed.
  A new comment always starts in Backlog and keeps the compact create form
  through its first autosave, so the editor never grows under your cursor;
  the status picker appears once you reopen it. **Save pin** commits a new
  comment; **Cancel** discards one that has no note yet.
  A screen with no feedback offers **Add feedback** in the panel, with how
  many comments are open elsewhere and a link to the next screen that has some.
  A note edit is saved to the comment it was typed in, even when you switch
  comment, pin or screen before the autosave fires. If a save or status
  change fails, the status picker shows the saved status again and a
  **Retry** button resends the change.
  Each status section has a **Hide pins / Show pins** switch on its right;
  Fixed and Verified pins are hidden by default and the choice is remembered
  per browser.
- **Approve screen** sits at the foot of the feedback panel. One click
  approves the screen (teal, "Screen approved"); click again to unapprove.
  If the screen still has Fixed comments nobody has verified, the click asks
  first ("1 fix not verified. Approve anyway?"). An approved screen shows an
  **Approved · date** pill beside its title.
  Approvals are saved per version and screen in `approvals.json`. Approved
  screens carry a teal check beside their number in the screen index, expanded,
  collapsed and fullscreen. The open-comment count is a matching orange badge
  beside it; a screen that is approved and still has open comments shows both
  side by side.
- **Hide approved screens**, a switch at the top of the screen index,
  drops approved screens from the list so only what's left to review remains.
  Turning it on from an approved screen moves you to the nearest open one. ↑ / ↓, ← / → and Prev / Next all skip
  the hidden rows; the choice is remembered.
- A **Showing** strip above each capture says exactly what it shows (for
  example "Step 3 of 5, manual path selected"). Click it to edit; Enter saves,
  Esc cancels. Text is saved per version and screen in `captions.json`; a
  screen's optional manifest `description` is the default, and clearing an
  edit restores it.
- Older feedback files are migrated on read: priority Blocking/Important/Polish
  becomes P0/P1/P2, the category becomes a tag, and a single `reply` becomes
  the first message of the thread. Files are written with `schemaVersion: 2`;
  a file without it is read as version 1 and only rewritten on the next change.
- Responsive layout: at 900px and below, screens become a numbered strip,
  centred on the current screen, and the feedback panel stacks under the
  canvas. At 480px and below the header wraps, feedback becomes a bottom sheet
  opened from **Feedback N**, Prev/Next become arrows around the screen
  counter, Add feedback becomes **+**, and Export and fullscreen move to a
  **More** menu.
- Real captures: registered projects are read from
  `~/.screencheck/projects/*.json` (override with
  `SCREENCHECK_PROJECTS`) and each screen's capture is shown at full width.
  The frame takes each capture's own proportions (never stretched to the
  registered viewport), so tall captures make the page longer; the page is the
  scroll area, the screen
  list keeps its place, and the feedback panel follows along.
- A fixed action bar keeps the fullscreen toggle (left), Prev/Next and the
  current screen (centre), and **Export** and **Add feedback** (right) in reach at the bottom
  of the window. The address bar records the project,
  version, and screen, so a reload or shared link opens the same place. A link
  to an older build opens that build, with a notice offering the newest one.

### Keyboard

| Keys              | Action                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⌘F / Ctrl+F       | Add feedback (replaces the browser's find in this app)                                                                                                                                              |
| Arrows, Enter     | While placing a pin: move the crosshair (Shift moves further) and drop the pin; Comment on whole screen pins the top left                                                                           |
| ← / → or [ / ]    | Previous / next screen (ignored while typing)                                                                                                                                                       |
| ↑ / ↓, Home / End | In the screen index: previous / next, first / last screen                                                                                                                                           |
| Tab               | The screen index is one tab stop; Skip to capture and Skip to feedback links come first                                                                                                             |
| ⌘A / Ctrl+A       | Approve / unapprove the screen (ignored while typing)                                                                                                                                               |
| B                 | Before / After: show the previous build's capture of this screen and size, and back                                                                                                                 |
| Enter / Esc       | In the Showing caption: save / cancel the edit                                                                                                                                                      |
| Enter or ,        | In Add tag: add the tag (Backspace when empty removes the last)                                                                                                                                     |
| Esc               | Undo the innermost thing only: close a dialog or confirm, cancel placing a pin, close the fullscreen feedback panel, then leave fullscreen. While typing, Esc never closes the panel or fullscreen. |

- Atomic file storage with serialized mutations, conflict checks, and restart
  recovery.

### Where feedback is stored

Feedback is written to disk by the server, never only to the browser:

```
~/.screencheck/feedback/<projectId>/feedback.json
```

Set `SCREENCHECK_DATA` to use another folder (useful for testing), or
`SCREENCHECK_HOME` to move everything. The server prints the folder it is
using on startup. Only one server process may use a data folder at a time: it
holds `server.lock` there while it runs, and a second one refuses to start and
names the first (a lock left by a crashed process is taken over).

API responses carry `Cross-Origin-Resource-Policy: same-origin`, and the app
page forbids framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). A
malformed path or project id gets `400`; storage failures get a `500` whose
details (including file paths) go only to the server log.

| Route                                                      | Purpose                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                             | `{"ok": true}` once the server is up; scripts and the playground poll it                                                                                                                                         |
| `GET /api/projects/:projectId/feedback`                    | List feedback                                                                                                                                                                                                    |
| `POST /api/projects/:projectId/feedback`                   | Create (idempotent on `clientMutationId`)                                                                                                                                                                        |
| `PATCH /api/projects/:projectId/feedback/:id`              | Update; `409` with the current record if `expectedUpdatedAt` is stale. See below for replies, messages and Verified                                                                                              |
| `DELETE /api/projects/:projectId/feedback/:id`             | Delete the expected revision                                                                                                                                                                                     |
| `GET /api/projects`                                        | Registered projects and screens (no local paths or proxy settings)                                                                                                                                               |
| `GET /api/projects/:projectId/captures/:version/:screenId` | A screen's capture image, only from inside that version's `captureRoot`; revalidated by `ETag`, so a re-capture shows at once                                                                                    |
| `GET /api/projects/:projectId/elements/:version/:screenId` | A screen's element map (`<capture>.elements.json`), only from inside `captureRoot`; `404` when there is none, `500` if malformed                                                                                 |
| `POST /api/projects/:projectId/feedback/import`            | Merge records saved elsewhere, keeping ids                                                                                                                                                                       |
| `GET /api/projects/:projectId/approvals`                   | Approved screens (stored beside `feedback.json` in `approvals.json`)                                                                                                                                             |
| `PUT /api/projects/:projectId/approvals`                   | Set `{version, screenId, approved}`; reviewer only (`x-screencheck-actor: reviewer`, else `403`); `409` with `unverified: N` while the screen has Fixed comments, unless `override: true`; returns the full list |
| `GET /api/projects/:projectId/captions`                    | Screen descriptions (stored beside `feedback.json` in `captions.json`)                                                                                                                                           |
| `PUT /api/projects/:projectId/captions`                    | Set `{version, screenId, text}`; empty text clears; returns the list                                                                                                                                             |

Feedback records carry `thread: [{id, author, role, note, at, status?}]`
(`role` is `reviewer` or `agent`; `status` is the change that message made)
and a derived `reply: {note, author, at}`, the latest agent message, for older
clients. In a PATCH:

- `reply: {note, author?}` appends an agent message (author defaults to
  `Agent`). `reply: null` removes the most recent agent message.
- `message: {note, author?, role?}` appends a message; `role` defaults to
  `reviewer`. Send `reply` or `message`, not both.
- The server stamps each message's `id` and `at`. If the same patch changes
  `status`, the message records the new status.
- Moving to Fixed or Won't fix needs a `reply` or `message` in the same patch.
- `status: "VERIFIED"` returns `403` unless the request carries
  `x-screencheck-actor: reviewer`. The same rule applies to create and import.

Every mutation must carry a loopback `Origin` header and a JSON body (1 MB
max); requests with a non-loopback `Host` header are refused. If
`feedback.json` cannot be parsed, the API returns `500` and the UI shows the
error with a Retry button — it never treats a damaged file as empty or
overwrites it.

Each write goes to a unique temp file that is renamed into place, and the
previous version is kept as `<file>.bak` (`feedback.json.bak`,
`approvals.json.bak`, `captions.json.bak`). Fields this build doesn't know
are kept when it rewrites a record, so an older build can't strip what a newer
one added. If a single record is invalid, the others still load: `GET` lists
the valid ones with a `problems` entry naming the bad record and field, and
writes return `409` until it is fixed or quarantined. `screencheck doctor`
checks every project; `--restore` puts a damaged file back from its `.bak`
(keeping the damaged copy as `<file>.damaged-<time>`), and `--quarantine`
moves invalid records to `feedback.rejected.json`.

Feedback saved by earlier builds in browser `localStorage` is imported on first
load. The browser copy is removed only after every record is accepted; anything
unreadable is left in place and reported. Project registrations, captures,
feedback, and injected headers must remain outside Git.

## Hand off a review offline

To get comments from someone who won't run ScreenCheck (a PM, a designer, a
client), send them a bundle:

```bash
# Latest version by default; repeat --version for more than one
npx screencheck bundle --project shop --version build-42
# -> shop-build-42.screencheck.zip
```

The zip holds the captures, the existing feedback, the project's public
registration (no local paths or headers) and a viewer. The reviewer unzips it
and opens `index.html` straight from disk: no server, no install, no account.
They see the same screens, pins and threads, and can add comments of their
own. New comments are kept in that browser's `localStorage` (they survive a
reload) and counted in the **Offline review** strip at the top; **Export
review** saves them as a `<project>-review-<time>.json` file to send back.
Feedback that came in the bundle, approvals and captions are read-only there.

Merge the reply back:

```bash
npx screencheck import shop-review-2026-10-27-08-05.json
```

`import` also takes a zip holding a review file. It goes through the same
import code as the server (the running server's import endpoint when there is
one), so comments already present are skipped by id: importing the same file
twice adds nothing. The project must be registered; `--project` overrides the
one named in the file. The viewer is built by `npm run build` (`dist/viewer`),
which ships in the npm package.

## Closing the loop (for agents)

After working through exported feedback, an agent answers each comment with
`screencheck reply`, which talks to the running ScreenCheck server (found
through `~/.screencheck/server.json`, or pass `--url` / `--port`):

```bash
# Open comments, tab-separated: id, version/screen pin N, status, tags, note
npx screencheck reply --project shop --list

# Narrow it down; --status takes a comma-separated list
npx screencheck reply --project shop --list --screen 3 --tag P0
npx screencheck reply --project shop --list --status fixed,wont-fix --json

# One comment in full: note, what the screen shows, the element under the pin
# and the whole thread
npx screencheck reply --project shop --show --id <feedbackId>

# Say what was done and mark it Fixed (or --status wont-fix with the reason)
npx screencheck reply --project shop \
  --id <feedbackId> --status fixed --author Copilot \
  --note "Moved the footer to the end of the page."
```

From a clone, `node scripts/reply.mjs` still works with the same flags.

`--status` accepts the same names as the MCP server (`fixed`, `wont-fix`,
`in-progress`, `backlog`, or API values like `RESOLVED`) and may be left out to
reply without moving the comment. Each reply is added to the comment's thread;
`--clear` removes the latest agent reply. Agents cannot mark a comment
Verified: they set Fixed and the reviewer verifies it in ScreenCheck.
`--screen` takes a screen id, its number in the index or its title. `--json`
prints the same comment objects as the MCP `list_feedback` tool. Markdown
exports list each comment's `id` so the agent can address it.

The CLI and the MCP server share one API client, so they number pins, name
statuses and handle conflicts the same way. If the reviewer edits a comment at
the same moment, the reply re-reads it and retries once. If the reviewer
changed its status meanwhile (verified it, reopened it), the agent's note is
still added but its status change is dropped, and the command fails with a
message naming the reviewer's change, so the agent rereads before acting.

## MCP server

Agents that speak MCP (Copilot CLI, Claude Code, VS Code) can read and answer
feedback directly. The MCP server runs on stdio and is a thin client over the
HTTP API above: it never reads feedback files itself, and it only talks to a
ScreenCheck on loopback (`127.0.0.1`, `localhost` or `[::1]`).

It finds the running server on its own: `--url`, then `SCREENCHECK_URL`, then
`~/.screencheck/server.json` (written by `screencheck serve` and `npm run dev`), then port 4173. It
looks this up on every call, so it can start before ScreenCheck does; until
then each tool says ScreenCheck isn't running.

| Tool              | What it does                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`   | Projects, versions and screens, with open-comment counts                                                                                                                                      |
| `list_feedback`   | Comments with pin number, screen, status, tags, note, latest message (labelled Reviewer or Agent) and pin position. Filters: `project`, `version`, `screen`, `status`, `tag`, `includeClosed` |
| `get_comment`     | One comment in full, the screen's caption, and a crop of the capture around the pin with the pin circled (`fullCapture: true` for the whole screen)                                           |
| `reply`           | Answer a comment (`note`) and optionally set `status`; retries once if the reviewer edited it meanwhile, but never overrides a status the reviewer just set                                   |
| `set_status`      | Change status without a note (closing as fixed or won't fix still needs `reply`)                                                                                                              |
| `approval_status` | Per-screen approval and open comments by priority for a version, e.g. `7/9 approved, 3 open (1 P0)`                                                                                           |

Statuses take the friendly names `backlog`, `in-progress`, `fixed` and
`wont-fix`. Agents can't set `verified`; only a reviewer can. Each project's
Markdown export is also a resource (`screencheck://project/<id>/feedback.md`),
and the `fix_open_feedback` prompt walks an agent through the open P0 and P1
comments. Replies are signed `Agent` unless the tool call passes `author` or
the server is started with `--author <name>` (or `SCREENCHECK_AUTHOR`).
Each comment's latest message says who wrote it (`Reviewer (Alex): …` or
`Agent (Copilot): …`), and `awaitingAgent: true` marks comments where the
reviewer spoke last, such as a fix reopened with a reason.

For MCP, install ScreenCheck once with `npm i -g screencheck` and use the
command `screencheck mcp`. The configs below use `npx -y screencheck mcp`,
which works without an install, but the first launch downloads the package
and can outlast an agent's MCP startup timeout, so ScreenCheck shows as failed
until the next session. From a clone, use
`npx tsx /path/to/screencheck/src/mcp/main.ts` instead.

Image processing uses [sharp](https://sharp.pixelplumbing.com/) when it's
installed (`npm i -g sharp` next to a global install). It is an optional
dependency, which keeps the install small: without it, `get_comment` crops PNG
captures with a built-in encoder and returns other formats (WebP, JPEG) whole,
without the pin drawn; `screencheck capture --out shot.webp` asks you to
install sharp or save a PNG.

**Copilot CLI** (`~/.copilot/mcp-config.json`):

```json
{
  "mcpServers": {
    "screencheck": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "screencheck", "mcp"],
      "tools": ["*"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add screencheck -- npx -y screencheck mcp
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "screencheck": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "screencheck", "mcp"]
    }
  }
}
```

## Register a project

The quickest way is to point ScreenCheck at a folder of captures:

```bash
# One version per subfolder (captures/build-41, captures/build-42, ...);
# a folder with images and no subfolders becomes version "v1".
npx screencheck init shop --captures ./captures --name Shop

# Later, add the next build as another version
npx screencheck add shop ./captures/build-43
```

`init` turns every PNG, JPEG or WebP into a screen: the id and title come from
the file name (`03_order-history.png` becomes "Order history"), the group is
"Screens", the description is the title and the viewport is the image size.
It writes `<id>.json` into the registry and refuses to overwrite one without
`--force`; `--projects <dir>` writes somewhere else. A running server picks
the file up on the next request. Edit the JSON afterwards to group screens
and describe what each capture shows.

Each project is one JSON file in `~/.screencheck/projects/` (or
`SCREENCHECK_PROJECTS`). Until one is registered, the app shows that folder,
a minimal file to copy and any files that failed to parse. Captures stay
wherever they already live; each version points at its folder:

```json
{
  "id": "shop",
  "name": "Shop",
  "versions": [
    { "id": "build-42", "captureRoot": "/path/to/captures/build-42" }
  ],
  "screens": [
    {
      "id": "checkout",
      "ordinal": 1,
      "title": "Checkout",
      "group": "Buy",
      "description": "Step 2 of 3, saved card",
      "capturePath": "checkout.png",
      "viewport": { "width": 1440, "height": 1000 }
    }
  ]
}
```

Only `id`, `ordinal`, `title` and `viewport` are required per screen: `group`
defaults to "Screens" and `description` to the title. A registration that
doesn't parse is listed in `problems` with the field at fault, for example
`try.json: screens[1].viewport: Invalid input: expected object, received undefined`.

A capture must sit inside its version's `captureRoot`. A relative
`capturePath` is read from the `captureRoot`, subfolders included
(`flows/checkout.png`); a path that climbs out of it is refused. An absolute
path outside the root falls back to the same file name inside it. Without a
`capturePath`, the capture is `<screen id>.webp`. A declared capture that is
missing, or one that points outside the root, is listed in `problems` from
`GET /api/projects` (and the inspector) rather than silently showing "No
capture". Registrations are re-read only when a file in the folder changes.

Feedback, approvals and captions are checked against the registry: a write
for an unregistered project, version or screen gets `404` naming the valid
ids (for example `Unknown project "shpo". Projects: shop, try.`), so a typo in
a script or agent can't save comments nobody will see. The `example`
placeholder project is always accepted.

To register a project from its own manifests, keep a small importer script
beside the registrations rather than in this repository.

## Versions, revisions and viewports

Each version is its own entry in the header's **Revision** picker, newest
(last) first; `build-41` and `build-42` are two builds. Version ids are never
split apart. If one build was captured at several viewports, say so with
optional `revision` and `label` fields; versions that share a `revision`
appear as one entry, a **Viewport** filter lists their labels, and the screen
index shows each screen once per viewport (`Checkout · 390`):

```json
"versions": [
  { "id": "b42-desktop", "revision": "build-42", "label": "1440", "captureRoot": "…/b42/desktop" },
  { "id": "b42-mobile", "revision": "build-42", "label": "390", "captureRoot": "…/b42/mobile" }
]
```

When an earlier build exists, the footer's **Before | After** toggle (or **B**)
flips the canvas to the previous build's capture of the same screen at the same
size. Pins are hidden while Before is showing, since they belong to the current
build. On phones it is in the **…** menu.

A capture must sit inside its version's `captureRoot`. To register a project
from its own manifests, keep a small importer script beside the registrations
rather than in this repository.

## Capturing long pages

Playwright's `fullPage` screenshot grows the capture, not the viewport, so a
footer or action bar with `position: fixed; bottom: 0` (or a stuck
`position: sticky; bottom: 0`) is painted at the bottom of the _first screen_,
in the middle of a long page. For a single shot, run
`npx screencheck capture <url> --out shot.png [--width 1440 --height 1000]
[--wait-for <selector>]`. Capture scripts should use the helper instead:

```ts
import { captureFullPage } from "screencheck/capture";

await captureFullPage(page, { path: "capture.webp", type: "webp" });
```

It moves bottom-anchored bars (at most half the viewport tall) to the end of the
document, takes the full-page shot, then restores their inline styles exactly.
Headers, full-screen dialogs, and pages shorter than the viewport are left
alone. Apps that scroll an inner container (a `100vh` body with its own
scroller) are not covered; capture those by scrolling the container instead.

## Element map

When `captureFullPage` is given a `path`, it also writes an element map beside
the capture: `checkout.png` gets `checkout.elements.json`. `screencheck capture`
writes one the same way, and swaps the image into place whole, so a re-capture
is never served half-written. It records the
visible, meaningful elements after the footer adjustments, so the boxes line up
with the full-page shot:

- interactive elements (links, buttons, fields, anything with a `role` or
  `tabindex`), headings, images, `header`/`nav`/`main`/`footer`/`aside` and
  labelled sections and forms, anything with `data-testid`, and blocks that
  hold text directly;
- for each: its box as fractions of the capture (like pin coordinates), role,
  accessible name (120 characters at most), tag, `data-testid`, a short
  selector (test id, then id, then a short CSS path) and, when it can tell,
  the source file.

Hidden, zero-size and `opacity: 0` elements are left out, and a page keeps at
most 2000 (interactive and tagged elements first). Pass `elements: false` to
skip the map or `elements: { path }` to write it elsewhere; the map is also
returned as `result.elements`.

A pin then names the element under it (the smallest box containing it): the
comment card shows `↳ button "Continue to vehicle" · Footer.tsx:42`, and
exports add `Element: button "Continue to vehicle" (src/booking/Footer.tsx:42)`
in Markdown and an `element` object in JSON. Screens without a map simply show
nothing. The shared helpers live in `src/shared/elements.ts`
(`elementMapSchema`, `resolvePinElement`, `describeElement`).

**Source files** are best effort, read in this order, and never required:

1. Attributes on the element or its nearest annotated ancestor:
   `data-source="src/booking/Footer.tsx:42:7"`, react-dev-inspector's
   `data-inspector-relative-path` / `-line` / `-column`,
   `data-source-file` / `-line`, Sentry's `data-sentry-source-file` and
   `data-sentry-component`, or `data-component`.
2. React development builds: `_debugSource` (React 18 and earlier) gives file,
   line and component; React 19 gives the component name and the file from its
   dev stack (no line, since dev-server stacks are not source-mapped).
3. Vue development builds: the component's `__file` and name.
4. Svelte development builds: `__svelte_meta.loc`.

To opt a build in, capture a development build, or add a compile-time plugin
that stamps JSX with a source attribute: for example
`@react-dev-inspector/babel-plugin` (Babel),
`@sentry/babel-plugin-component-annotate`, or an SWC plugin that writes
`data-source="file:line"`. Keep it out of production builds.

## Project site

`docs/` is the GitHub Pages site, so everything in it is public; a test keeps
it to `index.html`, `CNAME`, `PLAYGROUND.md` and `assets/` images (working
notes such as plans live in `.github/plans/`). Its screenshots come from a made-up ferry app
("Tidewater") so no real project appears in them. To regenerate them:

```bash
node scripts/site/build-shots.mjs          # writes docs/assets/*.png
node scripts/site/build-shots.mjs --serve  # leaves the seeded demo running on :4196
```

The script renders each demo screen through `captureFullPage` (which also
writes each screen's element map; the demo markup carries `data-source`
attributes so cards show a file), registers them
in a temporary folder, starts a server on port 4196 with temporary data, seeds
the comments, replies and approvals through the API, and captures the shots
listed in `scripts/site/shots.mjs`. Nothing touches `~/.screencheck`.
