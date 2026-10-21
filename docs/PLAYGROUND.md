# ScreenCheck playground

A seeded demo project for trying every ScreenCheck feature in about 15 minutes.
It captures **Tidewater**, a made-up ferry booking app (9 screens, two builds),
and fills it with feedback in every state, so nothing starts empty.

## Start it

From the repo:

```bash
npm install
npm run playground
```

This captures the screens, starts a ScreenCheck server on
**http://127.0.0.1:4299**, seeds the feedback and opens your browser. The
terminal prints the agent CLI and MCP commands you'll use in Part 3. Press
Ctrl+C to stop.

- Data lives in `~/.screencheck-playground`. Your changes survive a restart.
- `npm run playground -- --reset` wipes it and seeds again from scratch.
- `npm run playground -- --no-open` skips opening the browser.
- Use `PLAYGROUND_PORT=4300 npm run playground` if 4299 is taken.
- A `WebSocket server error: Port 24678 is already in use` warning means
  another ScreenCheck dev server is running. It's harmless.

## What's seeded

Tidewater has two builds: **build-41**, from before the agent's fixes, and
**build-42**, with them. Both ids end in a number, so ScreenCheck treats them
like two resolutions of one revision (see "Versions, revisions and
resolutions" in the README). The screen index lists every screen at both
builds, 18 rows labelled `· 41` and `· 42`, and the **Resolution** picker (top
right) narrows it to one build. It opens on **02 Sign in · 42**.

| Row                            | What's there                                       |
| ------------------------------ | -------------------------------------------------- |
| 02 Sign in · 42                | Approved (teal check in the rail)                  |
| 04 Home · 42                   | One Won't fix with an agent reply, one In progress |
| 05 Choose route · 41           | A P1 open on the older build                       |
| 06 Choose route · 42           | Pin 1 Fixed with a reply thread; pin 2 open        |
| 07 Pick a sailing · 41         | A P2 open on the older build                       |
| 08 Pick a sailing · 42         | One Verified, a P0 and a P1 open                   |
| 10 Vehicle and passengers · 42 | P0 In progress                                     |
| 12 Review and pay · 42         | Pin 1 Fixed with a reply; pin 2 P0 open            |
| 14 Booking confirmed · 42      | P2 open, for the agent to fix                      |
| 16 My trips · 42               | P1 open, for the agent to fix                      |
| 18 Settings · 42               | Blank and unapproved, for your own pins            |

The other rows have no feedback.

## Part 1: Look around (2 min)

1. **Screen index (left rail).** Screens are grouped Access, Booking, Account,
   and each one appears once per build: **05 Choose route · 41** sits right
   above **06 Choose route · 42**. Orange badges are open counts; a teal check
   means approved. Click **«** to collapse the rail to numbers.
2. **Move between screens.** Use **‹ Prev / Next ›** in the bottom bar, the
   **← →** keys, or **[ ]**; each step moves one row, through both builds.
   After clicking a row in the rail, **↑ ↓** step through the list and
   **Home / End** jump to the first or last row.
3. **Showing caption.** Above each capture, click the text after "SHOWING" to
   edit the note on what state the screen is in.
4. **Feedback panel (right).** Cards are grouped by status (Backlog, In
   progress, Fixed, Verified, Won't fix), then by priority (P0, P1, P2). Use
   **Hide pins / Show pins** on a group to declutter the capture.

## Part 2: Review like a designer (8 min)

5. **Drop a pin.** Go to **18 Settings · 42**, press **⌘F** (or click **Add
   feedback**), then click the **Save changes** button on the capture.
   - Type a note. It saves as you type; there's no Save button.
   - Click **P0**, type `Layout` in Add tag and press Enter.
   - The card shows an element line, `↳ span "Save changes"`. That's the
     element under your click, taken from the capture's element map.
   - **Cancel pin** removes a pin you haven't written anything on.
6. **Reply thread.** Go to **06 Choose route · 42** and open pin 1 under
   Fixed. You'll see the agent's reply, your follow-up and the agent's second
   fix. Add a reply in the Reply box.
7. **Approval guard.** Still on Choose route, tick **Approve screen** (or press
   **⌘A**). ScreenCheck asks "1 fix not verified. Approve anyway?" Click **Cancel**.
8. **Verify a fix.** On pin 1, click **Verify**. It moves to Verified. Only a
   reviewer can verify; agents can't. Tick **Approve screen** again: no
   warning this time, and the rail shows a teal check.
9. **Reopen a fix.** Go to **12 Review and pay · 42**, open pin 1 and click
   **Reopen**. It goes back to Backlog for the agent to try again.
10. **Approve your own screen.** On **18 Settings · 42**, tick **Approve
    screen**. Open comments don't block approval; only unverified fixes ask
    first.
11. **Compare builds.** Go to **05 Choose route · 41**, the row above the one
    you just reviewed. The older build has no "Save 10%" pill, and its old
    comment is there. To review one build at a time, set **Resolution** to
    `42`: the rail drops the `· 41` rows and renumbers 01–09. Set it back to
    **All**.
12. **Fullscreen.** Click the corner icon at the bottom left. The rail
    collapses and the feedback panel tucks away; ← → still work.
13. **Export.** Click **Export**. Choose Markdown or JSON, all screens or this
    one, and which statuses to include, then **Download**.
14. **Hide approved screens.** At the top of the screen index, click **Hide
    approved screens** to drop approved rows so only what's left to review
    remains.

## Part 3: Let an agent close the loop (5 min)

This is the other half of ScreenCheck: a coding agent reads open feedback,
fixes it and replies on the card.

### With the CLI

```bash
# List open feedback (id, screen and pin, status, tags, note)
npm run -s screencheck -- reply --url http://127.0.0.1:4299 --project tidewater --list

# Reply to one and mark it fixed (use a full id from the list)
npm run -s screencheck -- reply --url http://127.0.0.1:4299 --project tidewater \
  --id <id> --status fixed --note "Show ticket is now the primary button."
```

Go to **16 My trips · 42** in the browser. The card has moved to **Fixed** with the
agent's reply, and it waits for you to **Verify** or **Reopen**.

Other options: `--status in-progress|wont-fix|backlog`, `--author <name>`,
`--clear` to remove a reply, and `--all` with `--list` to include closed
items.

### With MCP

Add this to your MCP client config, for example `~/.copilot/mcp-config.json`
for Copilot CLI. Replace `<repo>` with the absolute path to this repo.

```json
{
  "mcpServers": {
    "screencheck-playground": {
      "type": "local",
      "command": "<repo>/node_modules/.bin/tsx",
      "args": ["<repo>/src/mcp/main.ts", "--url", "http://127.0.0.1:4299"],
      "tools": ["*"]
    }
  }
}
```

The server has six tools (`list_projects`, `list_feedback`, `get_comment`,
`reply`, `set_status`, `approval_status`) and one prompt, `fix_open_feedback`.
Try asking your agent:

> Use screencheck-playground to list open feedback on Tidewater's Booking
> confirmed screen, then reply to it as if you'd fixed it.

Then check **14 Booking confirmed · 42** in the browser.

## Start over

```bash
npm run playground -- --reset
```
