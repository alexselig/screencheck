# ScreenCheck roadmap

October 2026. A stack-ranked feature list, grounded in a scan of 30+ comparable
products (sources at the end).

## Where ScreenCheck stands

**Thesis:** the review surface you and your coding agent share, on your own
machine. A persistent, versioned inventory of an app's screens; numbered pins
with status, priority and approval; and an agent that reads the feedback and
answers each comment.

**What the market looks like in 2026**

| Cluster                                                                          | What they own                                                                           | What they lack                                                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bug-annotation SaaS (Marker.io, BugHerd, Jam, Userback, Usersnap, Gleap, Pastel) | Pins on live pages, console/network capture, session replay, Jira sync, guest reviewers | Local-first; versioned screen inventory; per-seat pricing ($39 to $999/mo) is the top complaint |
| Visual regression (Chromatic, Percy, Argos, Applitools)                          | Pixel diffs between builds, approve/deny gates in CI                                    | Human commenting. They are merge gates for engineers, not review surfaces                       |
| Preview comments (Vercel Toolbar, Netlify)                                       | Comments on preview deploys; Vercel added a `vercel comments` CLI in Aug 2026           | Works only on their hosting; no screen inventory, no versions                                   |
| Design handoff (Figma Dev Mode, Zeplin)                                          | Design-side comments, an MCP server for agents                                          | No formal review state; comments get buried; it reviews the design, not the build               |
| Agent-native annotators (Pinpoint, Vibe Annotations, stagewise, React Grab)      | Local, free, pipe annotations or the selected element straight into Claude Code/Cursor  | Ad-hoc, one session at a time: no inventory, no status over time, no approvals, no versions     |

**The whitespace ScreenCheck already sits in:** nobody combines (1) a persistent,
versioned screen inventory, (2) numbered pins with status, priority and approval,
(3) per-comment agent replies, and (4) local-only data with no accounts. Pinpoint
is the closest open-source analogue and lacks 1–3. Marker.io's MCP server is the
closest commercial analogue and is cloud SaaS.

**Where it is exposed:**

- ~~**No MCP server.**~~ Shipped (#1).
- **Onboarding means hand-writing project JSON** and writing your own capture
  script.
- ~~**Pins are pixels, not code.**~~ Element maps shipped (#2); captures
  taken before them still leave the agent guessing which element and file a
  pin means.
- **No version-to-version view**, even though versions are the core data model.
- **"Fixed" is the agent's word against nobody's.** Verify shipped (#3);
  before/after crops (#9) are still to come.

## Ranking method

Each item is scored on four things:

- **Loop impact:** does it shorten review → agent fix → verified?
- **Differentiation:** does it widen the gap with SaaS tools and ad-hoc annotators?
- **Reach:** does it bring in new users or keep existing ones?
- **Effort:** S is a day or two, M about a week, L several weeks. Estimates assume agent-assisted work.

Ties go to whatever unblocks later items.

## Stack-ranked features

### Now: close the agent loop

**Shipped in October 2026.** All five items below are on `main`: the MCP
server (`screencheck mcp`), element maps written by `captureFullPage`, the
reviewer-only Verified status with Verify/Reopen and the approval check,
threaded replies (`schemaVersion: 2`), and the `screencheck` CLI, published to
npm as `screencheck`. 0.1.0 was published from a manual workflow run; from
0.2.0 on, releases are tag-driven only: pushing `v<version>` runs
`publish.yml`, which checks the tag matches `package.json` and publishes with
provenance.

**Also on `main` since then:** a **Revision** picker, with versions sharing an
explicit `revision` treated as sizes of one build. The screen index lists each
screen once, a 390 · 768 · 1440 size switcher (Shift+← / →), Fit / 100% zoom,
**Compare sizes** and **Approve all sizes** sit on the canvas, and nothing is
guessed from version-id suffixes. This delivers most of #12.

| #   | Feature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Why it ranks here                                                                                                                                                                                     | Effort |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | **MCP server.** Tools: `list_feedback` (filters for project, version, status and tag), `get_comment` (note, tags, pin and **a crop of the capture around the pin**), `reply` (note plus status), `list_projects`, `approval_status`. A thin layer over the existing HTTP API, run with stdio transport through `npx screencheck mcp`. Keeps the loopback Origin and Host rules.                                                                                                              | Every peer (Marker.io, Jam, Figma, Vibe Annotations, Chrome DevTools) converged on MCP. Today agents need `reply.mjs` plus a port number. Highest leverage per hour.                                  | S–M    |
| 2   | **Element map at capture time.** `captureFullPage` also writes `<capture>.elements.json`. For each visible element it records the box (as % of the capture), role, text, `data-testid` and selector, plus the source file and line when the build exposes them (React dev `_debugSource`, Vite/Next source maps, `data-source` attributes). A pin then resolves to its innermost element. The MCP response and the Markdown export say "the `Continue` button, `src/booking/Footer.tsx:42`". | Solves the #1 friction in agent-era tools ("which file is this?") **without a browser extension**, and it works on old captures too. Nobody else attaches source mapping to a _versioned screenshot_. | M      |
| 3   | **Verify step.** A new `Verified` status, set only by a person, sits after `Fixed`. Fixed comments show the agent's reply with **Verify** and **Reopen** buttons. Reopening keeps the thread. A screen can't be approved while any of its comments is fixed but not yet verified, unless you override.                                                                                                                                                                                       | Turns "the agent says it's fixed" into a closed loop. It's small, and the trust problem it fixes is the main weakness of autonomous fixes.                                                            | S      |
| 4   | **Threads instead of one reply.** A comment holds an ordered list of messages (reviewer ↔ agent), each with author, time and an optional status change. The current `reply` field migrates to the first message.                                                                                                                                                                                                                                                                             | "Won't fix, because X" needs an answer. Reopen (#3) needs a place for the reason. Every SaaS peer has threads.                                                                                        | S–M    |
| 5   | **`npx screencheck` package.** Publish to npm: `screencheck serve`, `screencheck mcp`, `screencheck reply`, `screencheck capture`. Data stays in `~/.screencheck`.                                                                                                                                                                                                                                                                                                                           | Prerequisite for #1, #6 and outside adoption. Today you clone the repo.                                                                                                                               | S      |

### Next: versions become the product

Re-ranked October 2026 after testing the loop from zero. Serve, register,
capture, review and MCP all work, but every new build still means capturing by
hand, registering by hand and losing the open pins on the old version. The rail
now shows versions side by side, which makes feedback stuck on the old one more
costly. Capture and an explicit version model come first; carry-forward moves
ahead of compare.

| #   | Feature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why it ranks here                                                                                                                                                              | Effort         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 6   | ~~**`screencheck capture --config`: one-command capture and registration.**~~ _Shipped:_ `.mjs`/`.json` (and `.ts` on Node 22.18+) configs, `--version`, `--screen`; see README "Capture at several sizes". Takes a `screencheck.config.ts` that lists screens as a URL plus optional Playwright setup steps (log in, click to step 3, fill a form), a caption and the viewports to capture. It captures every screen at every viewport with `captureFullPage` (element maps on) into a new version folder and writes or updates the project registration. Supports `--screen` to re-capture a single screen. Plain `screencheck capture <url>` keeps meaning a single screenshot. | Removes hand-written JSON and bespoke scripts, the biggest onboarding wall. Makes versions cheap, which everything below depends on.                                           | M              |
| 6a  | ~~**Explicit revision × viewport model.**~~ _Shipped:_ optional `revision`, `viewport` and `label` per version; ids are never split. Registrations carry optional `revision` and `viewport` (or `label`) fields per version, and the rail groups by them. Without the fields, each version id is its own revision; any naming convention is opt-in and documented, never guessed from a suffix.                                                                                                                                                                                                                                                                                    | Today `build-41` / `build-42` read as one revision with two "resolutions". Fixing the model finishes #12 cheaply and gives #8 and #7 a clean notion of "the previous version". | M              |
| 8   | **Carry open pins forward.** When a new version lands, open comments move to it. Each pin is re-anchored by its element-map match (#2), falling back to its % position. Pins whose element vanished or moved are flagged "check placement".                                                                                                                                                                                                                                                                                                                                                                                                                                        | Without this, every new revision resets the review. Element maps (#2) already exist, so it no longer waits on anything.                                                        | M              |
| 10  | **Review rounds and release gate.** A version header shows N screens, N approved, open comments by priority, and what changed since the last round. `screencheck status --gate` exits non-zero while P0s are open or screens are unapproved, so it works in CI and pre-release scripts. _Shipped (CLI and MCP):_ `screencheck status --gate` with per-size rollup, `--json` and the `release_status` MCP tool; the in-app round summary strip is still open.                                                                                                                                                                                                                       | Small, and it makes ScreenCheck a CI and release step, not a side tool.                                                                                                        | S–M            |
| 7   | **Compare versions.** Shows a screen in two versions as an overlay (onion skin or slider) or as a pixel diff, built on the adjacent rows the rail already shows. Each screen in the index gets a "changed" dot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Visual diffs are siloed in CI tools ($100–600/mo) that have no human review. Putting them inside the review surface is the clearest gap in the market.                         | M              |
| 9   | **Before/after on every fix.** An agent's `reply --status fixed` can trigger `capture --config --screen` for that screen. The verify card (#3) then shows crops of the old and new capture around the pin, side by side.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Makes verification a 2-second glance. Combines #3, #6 and #7 into the signature ScreenCheck moment.                                                                            | S (after 6, 7) |

### Later: broaden who reviews and what is captured

| #   | Feature                                                                                                                                                                                                                                                                                           | Why                                                                                                                                                     | Effort |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 11  | ~~**Box and region pins.** Drag to draw a rectangle as well as clicking a point. The box is stored as % so it works at any size (compatible with Pinpoint's schema).~~ Shipped (#11): `box` in fractions, x/y at its centre. The arrow was left out.                                              | "This whole card" is common feedback. Boxes also make the element-map match and the crops more accurate.                                                | S      |
| 12  | **Viewports per screen.** _Mostly shipped:_ sizes of one revision, the size switcher, Fit / 100% zoom, Compare sizes and Approve all sizes are on `main`. Still open: comments that apply at every size.                                                                                          | Responsive review is a top use case. The data model already has `viewport`.                                                                             | M      |
| 13  | ~~**Offline review bundles.**~~ Shipped: `screencheck bundle` builds a `.screencheck.zip` holding captures, feedback and a static viewer that opens from file://. `screencheck import` merges a reviewer's exported comments back in, using the existing import endpoint.                         | Lets a PM or designer review without running anything and keeps the no-accounts promise. This is how Pinpoint does hand-off.                            | M      |
| 14  | ~~**AI assist through CopilotBridge.**~~ Shipped: `serve --assist` (off by default) runs the reviewer's own Copilot CLI tool-less, with no keys and no bill, to rewrite a note for an agent, suggest tags and a priority, and summarise a round. Duplicate hints use cheap local text similarity. | Gleap and Usersnap charge for this. ScreenCheck can do it for free and locally. It ranks below the loop work because the agent already does most of it. | M      |
| 15  | ~~**GitHub Issues sync.**~~ _Shipped:_ `screencheck issues` files comments as issues through `gh` (per comment or per screen) with a link back and a saved crop; `issues sync` moves a comment to Fixed when its issue closes.                                                                    | Two-way tracker sync is a recurring wish across Marker.io and BugHerd. GitHub comes first; Linear and Jira only if asked.                               | M      |
| 16  | **Automated checks become suggested comments.** At capture time, run axe accessibility rules and contrast checks. Violations appear as ghost pins (dashed, labelled "Suggested") that you can promote to real comments or dismiss.                                                                | Turns the capture pipeline into a reviewer's assistant. Promoting a suggestion stays a human decision.                                                  | M      |
| 17  | **Design reference beside the build.** Attach a Figma frame (via the Figma MCP or an exported PNG) to a screen and show it in compare mode (#7) as "Design".                                                                                                                                      | Design-vs-build review is the job Figma comments can't do.                                                                                              | M      |
| 18  | ~~**Reviewer identity without accounts.** A name per browser, stored locally and stamped on comments and messages, with `@agent` and `@name` mentions inside threads.~~ Shipped: inline "Your name", `author` on comments, mention chips, MCP `mentions` filter.                                  | Needed once more than one person reviews (#13). Costs nothing to the privacy model.                                                                     | S      |

### Explicitly not doing

Each of these is either owned by someone else or would break the thesis.

- **Cloud hosting and accounts.** Local-first is the moat against every SaaS peer.
  Sharing goes through bundles (#13), not a server.
- **Session replay and console/network capture.** Jam and Marker.io do this well,
  and it belongs to bug reporting, not screen review.
- **WYSIWYG editing of the app.** Onlook, Bolt and Lovable own this. ScreenCheck
  is where you decide _what_ should change, and the agent changes it.
- **Pinning on the live page as the primary mode.** Captures are what make
  versions, compare and carry-forward possible. Live pages stay a capture
  source (#6, `capture --config`), not the review surface.
- **LAN or remote access to the server.** It would undo the loopback-only
  security model. Use bundles instead.

## Sequencing

```
#5 npm package ──► #1 MCP ──► #3 Verify ──► #4 Threads
                     │
#2 Element map ──────┴──► #8 Carry forward
#6 capture --config ──► #6a revision × viewport ──► #8 Carry forward ──► #10 Gate
                                                         └──► #7 Compare ──► #9 Before/after
```

The first milestone, "the agent loop is closed", covers #5, #1, #2 and #3. It is
done when an agent can be told "fix the open P0s on build-43" and the reviewer
verifies each fix in one click, all through MCP, with no port numbers.

Success measures:

- time from capture to the first comment;
- the share of comments with a resolved source file;
- the median time from Fixed to Verified;
- the number of comments reopened after Fixed, which shows agent fix quality.

## Housekeeping before the milestone

- [x] Fix the failing `tests/screen-caption.test.tsx` "Escape cancels without saving".
- [x] Move `scripts/reply.mjs` into the CLI and keep a shim for the old path.
- [x] Version the on-disk schema (`feedback.json` gets a `schemaVersion`) before
      threads (#4) and carried pins (#8) change its shape.

## Sources

- Marker.io MCP: https://marker.io/marker-mcp ·
  https://marker.io/blog/mcp-server-auto-resolve-issues · pricing
  https://marker.io/pricing · reviews https://www.g2.com/products/marker-io/reviews
- Jam MCP: https://www.remote-mcp.com/servers/jam
- Gleap pricing and AI: https://www.gleap.ai/blog/gleap-pricing-explained
- BugHerd vs Usersnap: https://www.g2.com/compare/bugherd-vs-usersnap
- Vercel Comments and CLI (Aug 2026): https://vercel.com/docs/comments ·
  https://whatsnew.fyi/product/vercel/releases/2026-08-20-manage-vercel-toolbar-comments-from-the-cli
- Figma MCP: https://help.figma.com/hc/en-us/articles/39216419318551 ·
  Dev Mode critique https://robotostudio.com/blog/actually-using-figma-dev-mode-is-it-any-good
- Pinpoint: https://github.com/maferland/pinpoint
- Vibe Annotations: https://www.vibe-annotations.com/
- stagewise: https://github.com/stagewise-io/stagewise
- React Grab / Agentation: https://github.com/aidenybai/react-grab ·
  https://www.agentation.com/
- Onlook: https://github.com/onlook-dev/onlook
- Bolt Visual Edits: https://bolt.new/blog/visual-edits
- Cursor Design Mode: https://cursor.com/docs/agent/design-mode
- Chrome DevTools MCP: https://developer.chrome.com/blog/chrome-devtools-mcp
- Visual regression pricing: https://argos-ci.com/blog/percy-vs-chromatic-vs-argos ·
  https://argos-ci.com/blog/visual-testing-pricing

Unverified and treated as indicative only: Windsurf "Send Element" internals,
Lost Pixel's maintenance status, Netlify comment-CLI parity.
