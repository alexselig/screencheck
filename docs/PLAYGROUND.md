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

The version picker (top right) opens on **build-42**, the newer build.

| Screen               | What's there                                       |
| -------------------- | -------------------------------------------------- |
| 01 Sign in           | Approved (green check in the rail)                 |
| 02 Home              | One Won't fix with an agent reply, one In progress |
| 03 Choose route      | Pin 1 Fixed with a reply thread; pin 2 open        |
| 04 Pick a sailing    | One Verified, a P0 and a P1 open                   |
| 05 Vehicle           | P0 In progress                                     |
| 06 Review and pay    | Pin 1 Fixed with a reply; pin 2 P0 open            |
| 07 Booking confirmed | P2 open, for the agent to fix                      |
| 08 My trips          | P1 open, for the agent to fix                      |
| 09 Settings          | Blank and unapproved, for your own pins            |

**build-41** is the older build, with two open comments of its own.

## Part 1: Look around (2 min)

1. **Screen index (left rail).** Screens are grouped Access, Booking, Account.
   Orange badges are open counts; a green check means approved. Click
   **«** to collapse the rail to numbers.
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
   - Type a note. It saves as you type; there's no Save button.
   - Click **P0**, type `Layout` in Add tag and press Enter.
   - The card shows an element line, `↳ span "Save changes"`. That's the
     element under your click, taken from the capture's element map.
   - **Cancel pin** removes a pin you haven't written anything on.
6. **Reply thread.** Go to **03 Choose route** and open pin 1 under Fixed. You'll
   see the agent's reply, your follow-up and the agent's second fix. Add a
   reply in the Reply box.
7. **Approval guard.** Still on Choose route, tick **Approve screen** (or press
   **⌘A**). ScreenCheck asks "1 fix not verified. Approve anyway?" Click **Cancel**.
8. **Verify a fix.** On pin 1, click **Verify**. It moves to Verified. Only a
   reviewer can verify; agents can't. Tick **Approve screen** again: no
   warning this time, and the rail shows a green check.
9. **Reopen a fix.** Go to **06 Review and pay**, open pin 1 and click
   **Reopen**. It goes back to Backlog for the agent to try again.
10. **Approve your own screen.** On **09 Settings**, tick **Approve screen**.
    Open comments don't block approval; only unverified fixes ask first.
11. **Compare builds.** Switch the version picker to **build-41**. The Route
    screen has no "Save 10%" pill, and the old comments are there. Switch back
    to build-42.
12. **Fullscreen.** Click the corner icon at the bottom left. The rail
    collapses and the feedback panel tucks away; ← → still work.
13. **Export.** Click **Export**. Choose Markdown or JSON, all screens or this
    one, and which statuses to include, then **Download**.

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
