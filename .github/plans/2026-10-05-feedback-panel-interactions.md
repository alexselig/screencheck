# Feedback Panel Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add collapsible feedback status sections, reliable Backlog draft behavior, automatic editor scrolling, and a one-row inspector header with a colored comment count.

**Architecture:** Keep section presentation state inside `FeedbackInspector`, persisted through the same browser-local pattern already used for hidden pin statuses. Preserve the existing server-backed feedback model and explicitly create every new record with `OPEN`; use an editor ref and effect to open, scroll, and focus the active editor.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, CSS.

## Global Constraints

- Status-section collapse must not change pin visibility.
- New feedback defaults to Backlog (`OPEN`) and P1.
- Never rewrite a focused textarea value.
- Browser-only preferences must tolerate malformed local storage.
- Use existing Bauhausian tokens and zero-radius controls.

---

### Task 1: Collapsible Status Sections

**Files:**
- Modify: `src/client/components/feedback-inspector.tsx`
- Modify: `src/client/styles.css`
- Test: `tests/feedback-inspector.test.tsx`

**Interfaces:**
- Consumes: `FeedbackStatus`, `STATUS_SECTIONS`, `hiddenPinStatuses`
- Produces: local-storage-backed `collapsedStatuses: FeedbackStatus[]`

- [ ] **Step 1: Write failing section-interaction tests**

Add tests that click the `Backlog` section header, assert
`aria-expanded="false"` and absence of the list body, click again to restore
it, click `Hide Backlog pins` without changing `aria-expanded`, and remount
after collapse to verify persistence.

- [ ] **Step 2: Run the focused test**

Run:

```bash
npm test -- --run tests/feedback-inspector.test.tsx
```

Expected: FAIL because status headers are not toggle buttons and no collapsed
state is persisted.

- [ ] **Step 3: Implement section state and accessible markup**

Add a guarded local-storage reader/writer keyed as
`screen-review-workbench:collapsed-feedback-statuses`. Render a full-width
header button with `aria-expanded` and `aria-controls`; render the groups only
when expanded. Keep the pin toggle as a sibling button and stop its click from
reaching the header.

- [ ] **Step 4: Style the section header**

Use the existing section title typography and rules. Make the main toggle fill
the available row while the pin control retains its current compact treatment.

- [ ] **Step 5: Run focused tests and commit**

```bash
npm test -- --run tests/feedback-inspector.test.tsx tests/hidden-pins.test.tsx
git add src/client/components/feedback-inspector.tsx src/client/styles.css tests/feedback-inspector.test.tsx
git commit -m "feat: collapse feedback status sections"
```

Expected: focused tests PASS.

### Task 2: Backlog Draft and Editor Visibility

**Files:**
- Modify: `src/client/components/feedback-inspector.tsx`
- Modify: `src/client/app.tsx`
- Test: `tests/feedback-workflow.test.tsx`
- Test: `tests/feedback-inspector.test.tsx`

**Interfaces:**
- Consumes: `EMPTY_EDITOR`, `effectiveDraftPin`, `selectedRecord`
- Produces: editor-open effect that calls `scrollIntoView({ block: "nearest" })` and `focus()`

- [ ] **Step 1: Write failing draft behavior tests**

Add a component test proving a new draft resets a previously selected
In-progress editor to `OPEN`/P1. Add an integration test with mocked
`scrollIntoView` proving the note field is scrolled and focused after the pin
is placed.

- [ ] **Step 2: Run focused tests**

```bash
npm test -- --run tests/feedback-workflow.test.tsx tests/feedback-inspector.test.tsx
```

Expected: FAIL because the app only focuses and does not guarantee pane
visibility or force Backlog open.

- [ ] **Step 3: Implement draft reset and visibility**

When a create draft becomes active, set the editor to a fresh copy of
`EMPTY_EDITOR`, remove `OPEN` from collapsed statuses, then in a layout effect
call the editor section's `scrollIntoView({ block: "nearest" })` before
focusing the textarea. For selected saved records, force that record's status
open without resetting editor content.

- [ ] **Step 4: Remove duplicate focus ownership**

Remove the draft-textarea focus effect from `App`; `FeedbackInspector` becomes
the single owner of editor visibility and focus.

- [ ] **Step 5: Run focused tests and commit**

```bash
npm test -- --run tests/feedback-workflow.test.tsx tests/feedback-inspector.test.tsx tests/navigation.test.tsx
git add src/client/components/feedback-inspector.tsx src/client/app.tsx tests/feedback-workflow.test.tsx tests/feedback-inspector.test.tsx
git commit -m "fix: reveal new feedback editor"
```

Expected: focused tests PASS.

### Task 3: Inspector Header and Regression Verification

**Files:**
- Modify: `src/client/components/feedback-inspector.tsx`
- Modify: `src/client/styles.css`
- Test: `tests/feedback-inspector.test.tsx`

**Interfaces:**
- Consumes: `visibleFeedback.length`
- Produces: `.feedback-inspector-count` rendered on the header's right edge

- [ ] **Step 1: Write the failing header test**

Assert that the inspector header contains `Feedback` and `3 comments` in the
same header container and that the count has the
`feedback-inspector-count` class.

- [ ] **Step 2: Run the focused test**

```bash
npm test -- --run tests/feedback-inspector.test.tsx
```

Expected: FAIL because the count is currently stacked beneath the eyebrow.

- [ ] **Step 3: Implement and style the one-row header**

Render `Feedback` as the left title and the pluralized count as the right
element. Use `var(--bauhaus-blue)` for the count and preserve 12px supporting
type.

- [ ] **Step 4: Run all validation**

```bash
npm test
npm run build
```

Expected: all tests and the production build PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/feedback-inspector.tsx src/client/styles.css tests/feedback-inspector.test.tsx
git commit -m "style: clarify feedback inspector header"
```
