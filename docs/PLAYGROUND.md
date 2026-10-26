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
**build-42**, with them. Each is one entry in the **Revision** picker (top
right), which opens on the newer build-42. build-42 was captured at three
sizes, **390**, **768** and **1440** wide, and opens at 1440; build-41 only at 1440. The table describes build-42 at 1440.

| Screen                    | What's there                                       |
| ------------------------- | -------------------------------------------------- |
| 01 Sign in                | Approved at every size (solid teal check)          |
| 02 Home                   | One Won't fix with an agent reply, one In progress |
| 03 Choose route           | Pin 1 Fixed with a reply thread; pin 2 open        |
| 04 Pick a sailing         | One Verified, a P0 and a P1 open                   |
| 05 Vehicle and passengers | P0 In progress                                     |
| 06 Review and pay         | Pin 1 Fixed with a reply; pin 2 P0 open            |
| 07 Booking confirmed      | P2 open; approved at 1440 only (outlined check)    |
| 08 My trips               | P1 open, for the agent to fix                      |
| 09 Settings               | Blank and unapproved, for your own pins            |

**build-41** is the older build, with two open comments of its own. At 390,
**02 Home** has one more open comment, about the headline wrapping.

## Part 1: Look around (2 min)

1. **Screen index (left rail).** Screens are grouped Access, Booking, Account.
   Each screen is listed once. Orange badges count open comments across every
   size; a solid teal check means approved at every size, an outlined one
   approved at some (hover it to see which). Click **«** to collapse the rail
   to numbers.
2. **Move between screens.** Use **‹ Prev / Next ›** in the bottom bar, the
   **← →** keys, or **[ ]**. After clicking a screen in the rail, **↑ ↓**
   step through the list and **Home / End** jump to the first or last screen.
3. **Showing caption.** Above each capture, click the text after "SHOWING" to
   edit the note on what state the screen is in.
4. **Feedback panel (right).** Cards are grouped by status (Backlog, In
   progress, Fixed, Verified, Won't fix), then by priority (P0, P1, P2). Use
   **Hide pins / Show pins** on a group to declutter the capture.

## Part 2: Review like a designer (8 min)

5. **Drop a pin.** Go to **09 Settings**, press **⌘F** (or click **Add
   feedback**), then click the **Save changes** button on the capture.
   - Type a note. It saves as you type; **Save pin** closes the editor.
   - Click **P0**, type `Layout` in Add tag and press Enter.
   - The card shows an element line, `↳ span "Save changes"`. That's the
     element under your click, taken from the capture's element map.
   - **Cancel** removes a pin you haven't written anything on.
6. **Reply thread.** Go to **03 Choose route** and open pin 1 under Fixed. You'll
   see the agent's reply, your follow-up and the agent's second fix. Add a
   reply in the Reply box.
7. **Approval guard.** Still on Choose route, tick **Approve screen at 1440**
   (or press **⌘A**). ScreenCheck asks "1 fix not verified. Approve anyway?" Click **Cancel**.
8. **Verify a fix.** On pin 1, click **Verify**. It moves to Verified. Only a
   reviewer can verify; agents can't. Tick **Approve screen at 1440** again:
   no warning this time, and the rail shows an outlined check, because 390 and
   768 are still to review.
9. **Reopen a fix.** Go to **06 Review and pay**, open pin 1 and click
   **Reopen**. It goes back to Backlog for the agent to try again.
10. **Approve your own screen.** On **09 Settings**, click **Approve all
    sizes**. Open comments don't block approval; only unverified fixes ask
    first. ⌘A approves just the size you're looking at.
11. **Review every size.** Go to **02 Home**.
    - The switcher above the capture reads **390 Phone · 768 Tablet · 1440
      Desktop**. Click **390**, or press **Shift+←** / **Shift+→** to step
      sizes. The size sticks as you move between screens, and the URL keeps it.
    - At 390 the Home screen has its own comment. Pins belong to one size.
    - **Fit** shows the whole width; **100%** shows actual pixels and the
      canvas scrolls. Pins scale with the capture.
    - **Compare sizes** lays every size of the screen side by side with its
      pins. Click one to open it, or press Esc to go back where you were.
    - **Before / After** in the bottom bar only appears at 1440 here, the one
      size build-41 has.
    - At 1440 a **Toggle · Overlay · Slider · Diff** picker sits above the
      capture. On **03 Choose route**, try **Slider** (drag, or ← / →) to see
      the "Save 10%" pill appear, or **Diff** to see it in orange. Route,
      Pick a sailing and Review and pay have a blue dot in the index: they
      changed since build-41.
12. **Compare builds.** Switch the **Revision** picker to **build-41**. The Route
    screen has no "Save 10%" pill, and the old comments are there. The
    Fixed card on **04 Pick a sailing** shows **Before** and **After** crops: the fix
    landed in build-42. Switch back to build-42.
13. **Fullscreen.** Click the corner icon at the bottom left. The rail
    collapses and the feedback panel tucks away; ← → still work.
14. **Export.** Click **Export**. Choose Markdown or JSON, all screens or this
    one, and which statuses to include, then **Download**.
15. **Hide approved screens.** At the top of the screen index, flip the **Hide
    approved screens** switch to drop approved rows so only what's left to
    review remains.

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

Go to **08 My trips** in the browser. The card has moved to **Fixed** with the
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

Then check **07 Booking confirmed** in the browser.

## Start over

```bash
npm run playground -- --reset
```
