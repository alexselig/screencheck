# Feedback Panel Interactions Design

## Goal

Make the feedback pane easier to scan and make new-comment entry reliably visible.

## Behavior

- Every non-empty status section header is a button that expands or collapses
  the section's comment groups.
- The existing Hide/Show pins button remains independent and does not toggle
  the section body.
- Section state is remembered in browser local storage by feedback status.
- A status section containing the active editor is forced open.
- Starting a new comment resets the draft editor to Backlog (`OPEN`) with the
  existing default P1 priority, opens Backlog, scrolls the feedback pane until
  the editor is visible, and focuses the note field.
- The inspector header is one row: `Feedback` on the left and the comment count
  on the right. The count uses Bauhaus blue so it is visually distinct without
  introducing another semantic color.

## State and Data Flow

The interaction state remains client-only. A small local-storage record stores
collapsed statuses; feedback status itself remains server-backed through the
existing API. Creating a record continues to send `status: "OPEN"` explicitly,
so the default is enforced at both editor and persistence boundaries.

The editor owns a scroll anchor. When a draft pin appears or a saved comment is
selected, an effect opens the relevant status, calls `scrollIntoView` with the
nearest block alignment, then focuses the textarea. The effect never rewrites a
focused textarea value.

## Accessibility

- Section headers expose `aria-expanded` and `aria-controls`.
- The header button has a full-width hit target; the pin-visibility button
  stops propagation so the controls remain independent.
- Collapsed bodies are removed from keyboard navigation.
- Existing editor and status labels remain unchanged.

## Error Handling

Malformed local-storage state is ignored and replaced with the default expanded
state. Feedback API failures continue to use the existing recovery and retry
messages; collapsing a section does not discard pending editor state.

## Testing

- Section header click and keyboard activation expand/collapse the body.
- Hide/Show pins does not collapse the section.
- Collapsed state survives remount.
- A selected editor forces its status section open.
- New feedback uses Backlog/P1, opens Backlog, scrolls the editor into view,
  focuses the note field, and persists `OPEN`.
- The header renders the title and differently colored count on one row.
