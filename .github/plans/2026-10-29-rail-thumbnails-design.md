# Screen index thumbnails and a resizable rail

Status: proposed, awaiting Alex's review. Nothing is built yet.

## What Alex asked for

1. A toggle to show or hide thumbnails in the screen index.
2. Whether that will be performant.
3. A draggable left nav; dragging it wider makes the thumbnails larger.

## Decisions (made autonomously; flag any to change)

| Question                       | Decision                                                                                                    | Why                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Where the toggle lives         | Top of the rail, a second switch under **Hide approved screens**, labelled **Show thumbnails**              | It controls the rail, so it sits on the rail; it reuses the existing switch style |
| Default                        | Off                                                                                                         | Keeps today's dense list; nothing changes until someone opts in                   |
| Remembered                     | Yes, in `localStorage` (like hidden pin statuses)                                                           | Same pattern as the rest of the client                                            |
| What a thumbnail shows         | The **top of the screen**, cropped to the screen's viewport ratio (1440 × 1000 shows the first 1440 × 1000) | A whole full-page capture squashed into a rail is an unreadable sliver            |
| Which capture                  | The current revision at the current size (follows the size switcher)                                        | Matches what the canvas shows                                                     |
| Compact rail (64px) and phones | No thumbnails; the toggle is hidden                                                                         | There is no room; the phone strip is a single row                                 |
| Rail width range               | 220px to `min(50vw, 640px)`, default 280px                                                                  | Below 220 the titles truncate; above half the window the canvas gets too small    |
| Dragging past the minimum      | Below 160px the rail snaps to compact mode                                                                  | Makes the existing collapse a natural end of the same gesture                     |

## Performance: the goal is zero cost on the main thread

Short answer: yes, if thumbnails are real small files and full captures are
never decoded just to draw one. Shrinking a full capture with CSS is the trap.
A 1440 × 6000 capture decodes to about 35 MB of bitmap even when drawn 240px
wide, so 50 rows would use more than a gigabyte and scrolling would stutter.

### Where thumbnails come from (fastest first)

1. **Written at capture time.** `captureFullPage` already has the page open.
   After the full-page shot it takes a second `page.screenshot` clipped to the
   first viewport (the top of the screen), which costs milliseconds. The server
   stores two WebP widths, 400 and 800px (about 15–40 KB each), in the
   thumbnail cache. Reviewing then costs only one small fetch per visible row.
2. **On-disk cache for every other capture.** Captures registered with
   `init --captures`, or made before this ships, have no thumbnail. The first
   time one is needed, a **Web Worker** makes it:
   - it fetches the capture;
   - `createImageBitmap` decodes and crops to the top viewport off the main
     thread;
   - an `OffscreenCanvas` resizes it to 400 and 800px and saves WebP (PNG
     where Safari can't write WebP).

   The worker posts both sizes back to the server's thumbnail cache, so this
   happens **once per capture, ever**, not once per visit or per reviewer.

3. **Offline viewer (`file://`).** There is no server to post to, so worker
   thumbnails stay in memory for the session. Bundles built after this ships
   include the cached thumbnails, so this path is rare.

### Storage and serving

- The cache lives in `~/.screencheck/thumbs/<project>/<version>/<screen>-<w>.webp`
  (moves with `SCREENCHECK_HOME`). It is never inside a capture folder, so the
  scan in `init --captures` can't mistake a thumbnail for a screen.
- It is keyed by the source capture's size and mtime, kept in a small sidecar
  file. Re-capturing a screen makes its thumbnail stale, and it is regenerated
  on the next request.
- `GET /api/projects/:id/thumbnails/:version/:screen?w=400|800` returns the
  file with a strong ETag and `cache-control: no-cache` (a 304 costs
  microseconds). It returns 404 when there is no thumbnail, which tells the
  client to fall back to the worker.
- `PUT` on the same route stores a worker-made thumbnail and follows the
  existing security model:
  - 127.0.0.1 only, with the Origin and Host checks;
  - the body must be at most 256 KB and start with a WebP or PNG signature;
  - the project, version and screen must exist;
  - `w` must be 400 or 800.

### Loading in the browser

- `<img srcset="…?w=400 400w, …?w=800 800w" sizes="var(rail)">` with
  `loading="lazy"`, `decoding="async"` and `fetchpriority="low"`. The browser
  picks the smallest file that is sharp at the current rail width and screen
  density. Dragging the rail wider swaps in the 800 file once; dragging it
  narrower never fetches anything.
- Each thumbnail box has a fixed `aspect-ratio` from the screen's viewport,
  so nothing shifts as images arrive.
- Rows use `content-visibility: auto` with `contain-intrinsic-size`. The
  browser skips layout and paint for off-screen rows, so a 500-screen index
  costs about the same as 20.
- The worker queue runs at most two jobs at a time. It pauses while the main
  canvas capture is loading, so the screen under review always wins.
- With the toggle off, no thumbnail code runs and nothing is fetched. The
  worker and module load lazily (dynamic `import()`) the first time the
  toggle is turned on.

### Dragging without re-rendering

- During a drag, `pointermove` writes `--rail-width` straight onto the grid
  element inside `requestAnimationFrame`. React does not re-render, and the
  thumbnails rescale with CSS.
- React state and `localStorage` are updated once, on `pointerup`.
- The grid transition is turned off while dragging.
- The rail column gets `contain: layout paint`, so resizing it doesn't
  re-lay out the feedback panel.

### Performance budget (checked, not assumed)

A Playwright script, `scripts/perf/rail-thumbnails.mjs`, runs against a
playground with 120 screens and tall captures. It uses Chrome DevTools
Protocol metrics and fails on any of these:

- **Toggling thumbnails on:** the first visible thumbnails must show within
  150 ms with cached files, or 600 ms when the worker has to make them. No
  main-thread task may exceed 50 ms.
- **Scrolling the whole index:** no long task over 50 ms, and no layout
  shift.
- **Dragging the rail from 220 to 640px:** every frame within 16 ms, and no
  React commits during the drag.
- **Memory:** JS heap plus decoded images stay within 20 MB of the
  thumbnails-off baseline after scrolling all 120 rows.

## Resizable rail

- A vertical handle on the rail's right edge: 1px ink rule, 8px hit area,
  `cursor: col-resize`, blue on hover and while dragging (house style, no
  shadow).
- It is a focusable `role="separator"` with `aria-orientation="vertical"`,
  `aria-valuenow/min/max` and the label "Resize screen index". The arrow keys
  move it 16px (Shift 64px); Home and End jump to the minimum and maximum.
  Double-click (or Enter) resets to 280px.
- Width is a `--rail-width` custom property on `.workbench-grid`
  (`grid-template-columns: var(--rail-width) minmax(0, 1fr) 320px`). The
  grid transition is turned off while dragging so it tracks the pointer.
  Pointer capture keeps the drag going outside the handle.
- The width is remembered in `localStorage` and clamped again on window
  resize. Fullscreen review uses the same width.
- Wider with thumbnails off simply shows longer titles.

## Units

- `src/client/use-rail-width.ts`: width state, clamp, persist, snap to
  compact. Pure helpers are unit-tested.
- `src/client/components/rail-resizer.tsx`: the separator (pointer and
  keyboard).
- `src/capture/thumbnail.ts`: the viewport-clipped shot at capture time.
- `src/server/thumbnails.ts`: the disk cache (staleness by source size and
  mtime) and the GET and PUT route.
- `src/client/thumbnail-worker.ts`: the worker that decodes, crops and
  resizes with `createImageBitmap` and `OffscreenCanvas`.
- `src/client/thumbnails.ts`: the queue (two jobs at a time, paused while the
  canvas loads) and the fallback that uploads to the cache, or keeps the
  result in memory offline.
- `src/client/components/screen-thumbnail.tsx`: the lazy row image with a
  fixed aspect ratio and a quiet placeholder (`--surface-alt` block).
- `screen-rail.tsx`: the **Show thumbnails** switch and a thumbnail slot in
  each row. `app.tsx` only passes the width and toggle through.

## Testing

- Unit: width clamp and snap; persisted toggle and width; queue concurrency
  (never more than two jobs at a time, paused while the canvas loads).
- Server: cache hit, stale after recapture, 404 when missing; PUT rejects a
  bad Origin, an oversize body, a non-image body, an unknown screen and an
  unknown width.
- Capture: `captureFullPage` writes both thumbnail widths (with a fake page).
- Component (vitest and testing-library): the toggle shows and hides the
  thumbnails; thumbnails are hidden in compact mode and on phones; the
  separator responds to the arrow keys, Home, End and double-click; a
  thumbnail requests only after its row intersects (mocked
  `IntersectionObserver`).
- The performance budget script above, run before merge, with its numbers
  recorded in the PR description.
- Design-token tests keep passing (token spacing only, 11/13px type).

## Out of scope

- Thumbnails in the phone strip, the compact rail or Compare sizes.
- Resizing the feedback panel on the right (same component could do it
  later).
