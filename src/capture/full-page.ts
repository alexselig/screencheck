// Full-page captures without mid-page footers.
//
// Playwright's full-page screenshot grows the capture, not the viewport, so a
// `position: fixed` or stuck `position: sticky` bar with `bottom:` is painted
// where the first screenful ends, in the middle of a long page. Before the
// shot, captureFullPage re-pins those bars to where they belong on a page
// that tall: fixed bars to the document's bottom edge, sticky bars back to
// their place in the flow. Afterwards the page is restored exactly.
//
// Usage from any Playwright script or spec:
//   import { captureFullPage } from "screencheck/capture";
//   await captureFullPage(page, { path: "screen.webp", type: "webp" });
//
// It also writes an element map beside the capture (`screen.elements.json`):
// the visible, meaningful elements with their boxes as fractions of the
// capture, so a pin can name what it points at.

// Only type imports from the repo, so Node can run this file directly.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { A11yReport } from "../shared/a11y";
import type { ElementMap } from "../shared/elements";

export type PinnedChromeReport = {
  // Bars moved for the capture, described as "tag.class" for logs.
  pinned: string[];
};

// Runs in the page; must stay self-contained because Playwright serialises it.
export function pinBottomChromeInPage(): PinnedChromeReport {
  type Saved = { element: HTMLElement; style: string | null };
  const store = window as unknown as Record<string, Saved[] | undefined>;
  const key = "__screenReviewPinnedChrome";

  function describe(element: Element) {
    const className =
      typeof element.className === "string" && element.className.trim()
        ? `.${element.className.trim().split(/\s+/).join(".")}`
        : "";
    return `${element.tagName.toLowerCase()}${className}`;
  }

  if (store[key]) {
    return { pinned: store[key]!.map(({ element }) => describe(element)) };
  }

  window.scrollTo(0, 0);
  const viewportHeight = window.innerHeight;
  const root = document.scrollingElement ?? document.documentElement;
  const documentHeight = Math.max(
    root.scrollHeight,
    document.body?.scrollHeight ?? 0,
  );
  const saved: Saved[] = [];
  store[key] = saved;
  if (documentHeight <= viewportHeight + 1) return { pinned: [] };

  // Computed `bottom` resolves to pixels even when it was `auto`, so probe:
  // a bar held by its bottom edge moves once that edge is released.
  function heldByBottom(element: HTMLElement) {
    const before = element.getBoundingClientRect().top;
    const style = element.getAttribute("style");
    element.style.setProperty("bottom", "auto", "important");
    const after = element.getBoundingClientRect().top;
    element.getAttribute("style"); // flush pending CSSOM writes so the removal sticks
    if (style === null) element.removeAttribute("style");
    else element.setAttribute("style", style);
    return Math.abs(after - before) > 0.5;
  }

  const bars: { element: HTMLElement; sticky: boolean }[] = [];
  for (const element of document.querySelectorAll<HTMLElement>("body *")) {
    const style = getComputedStyle(element);
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    const rect = element.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) continue;
    // Bars only: overlays and dialogs that fill the viewport stay put.
    if (rect.height > viewportHeight / 2) continue;
    // A bar inside another moved bar travels with its parent.
    if (bars.some((bar) => bar.element.contains(element))) continue;
    if (!heldByBottom(element)) continue;
    bars.push({ element, sticky: style.position === "sticky" });
  }

  for (const { element, sticky } of bars) {
    const rect = element.getBoundingClientRect();
    const bottom = parseFloat(getComputedStyle(element).bottom) || 0;
    saved.push({ element, style: element.getAttribute("style") });
    const set = (property: string, value: string) =>
      element.style.setProperty(property, value, "important");
    if (sticky) {
      // Unstuck, a sticky bar sits where the layout puts it.
      set("position", "relative");
      set("top", "auto");
      set("bottom", "auto");
      continue;
    }
    set("position", "absolute");
    set("top", "0px");
    set("bottom", "auto");
    set("left", "0px");
    set("right", "auto");
    set("width", `${rect.width}px`);
    // Measure the containing block's origin, then place the bar so its
    // bottom edge is `bottom` px above the end of the document.
    const origin = element.getBoundingClientRect();
    set("top", `${documentHeight - bottom - rect.height - origin.top}px`);
    set("left", `${rect.left - origin.left}px`);
  }
  return { pinned: bars.map(({ element }) => describe(element)) };
}

// Runs in the page; undoes pinBottomChromeInPage.
export function restoreBottomChromeInPage() {
  type Saved = { element: HTMLElement; style: string | null };
  const store = window as unknown as Record<string, Saved[] | undefined>;
  const key = "__screenReviewPinnedChrome";
  for (const { element, style } of store[key] ?? []) {
    element.getAttribute("style"); // flush pending CSSOM writes so the removal sticks
    if (style === null) element.removeAttribute("style");
    else element.setAttribute("style", style);
  }
  delete store[key];
}

// Runs in the page after the bars are re-pinned, so boxes match the shot.
// Must stay self-contained because Playwright serialises it.
export function collectElementsInPage(): ElementMap {
  const LIMIT = 2000;
  const NAME_MAX = 120;
  type Source = {
    file?: string;
    line?: number;
    column?: number;
    component?: string;
  };
  type Mapped = ElementMap["elements"][number];

  const docElement = document.documentElement;
  const scroller = document.scrollingElement ?? docElement;
  const width = Math.max(
    scroller.scrollWidth,
    document.body?.scrollWidth ?? 0,
    docElement.clientWidth,
    1,
  );
  const height = Math.max(
    scroller.scrollHeight,
    document.body?.scrollHeight ?? 0,
    docElement.clientHeight,
    1,
  );

  const SKIP = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "link",
    "meta",
    "title",
    "br",
    "wbr",
    "option",
    "optgroup",
    "source",
    "track",
  ]);
  const INTERACTIVE =
    "a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=''], [contenteditable=true]";
  const LANDMARKS = new Set(["header", "nav", "main", "footer", "aside"]);
  const IMPLICIT_ROLES: Record<string, string> = {
    button: "button",
    select: "combobox",
    textarea: "textbox",
    img: "img",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    section: "region",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "table",
    dialog: "dialog",
    summary: "button",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
  };
  const INPUT_ROLES: Record<string, string> = {
    button: "button",
    submit: "button",
    reset: "button",
    image: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    number: "spinbutton",
    search: "searchbox",
  };
  const SOURCE_ATTRIBUTES =
    "[data-source], [data-source-file], [data-inspector-relative-path], [data-sentry-source-file], [data-sentry-component], [data-component]";
  // Roles named by their text, as in ARIA's "name from content".
  const NAMED_BY_CONTENT = new Set([
    "button",
    "link",
    "heading",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "cell",
    "gridcell",
    "columnheader",
    "rowheader",
    "treeitem",
    "tooltip",
    "switch",
    "checkbox",
    "radio",
  ]);

  function clean(text: string | null | undefined) {
    const value = (text ?? "").replace(/\s+/g, " ").trim();
    return value.length > NAME_MAX ? `${value.slice(0, NAME_MAX - 1)}…` : value;
  }

  function roleOf(element: Element, tag: string) {
    const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    if (tag === "a") return element.hasAttribute("href") ? "link" : undefined;
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      return INPUT_ROLES[type] ?? "textbox";
    }
    if (tag === "section" || tag === "form") {
      return element.hasAttribute("aria-label") ||
        element.hasAttribute("aria-labelledby")
        ? IMPLICIT_ROLES[tag]
        : undefined;
    }
    return IMPLICIT_ROLES[tag];
  }

  function nameOf(element: HTMLElement, tag: string, role: string | undefined) {
    const label = element.getAttribute("aria-label");
    if (label?.trim()) return clean(label);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (text.trim()) return clean(text);
    }
    if (tag === "img") return clean(element.getAttribute("alt"));
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const field = element as HTMLInputElement;
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      if (["button", "submit", "reset"].includes(type) && field.value) {
        return clean(field.value);
      }
      const fieldLabel = field.labels?.[0]?.textContent;
      return clean(
        fieldLabel ||
          element.getAttribute("placeholder") ||
          element.getAttribute("title"),
      );
    }
    // Containers are not named after everything inside them.
    if ((role && NAMED_BY_CONTENT.has(role)) || hasOwnText(element)) {
      return clean(element.innerText || element.textContent);
    }
    return "";
  }

  function selectorOf(element: Element) {
    const quote = (value: string) =>
      `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `[data-testid=${quote(testId)}]`;
    if (
      element.id &&
      document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1
    ) {
      return `#${CSS.escape(element.id)}`;
    }
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && node !== document.body && node !== docElement) {
      if (node !== element) {
        const anchorId = node.getAttribute("data-testid");
        if (anchorId) {
          parts.unshift(`[data-testid=${quote(anchorId)}]`);
          break;
        }
        if (node.id) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
      }
      if (parts.length === 4) break;
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      const same = parent
        ? [...parent.children].filter(
            (child) => child.tagName === node!.tagName,
          )
        : [];
      parts.unshift(
        same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag,
      );
      node = parent;
    }
    return parts.join(" > ") || element.tagName.toLowerCase();
  }

  // Dev-server URLs become project paths: `http://host/src/A.tsx?t=1` is
  // `src/A.tsx`, and Vite's `/@fs/abs/path` is `/abs/path`.
  function trimFile(file: string) {
    const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)$/i.exec(file);
    if (!url) return file;
    const pathname = url[1]!.replace(/[?#].*$/, "");
    return file.startsWith("file:") || pathname.startsWith("/@fs/")
      ? pathname.replace(/^\/@fs/, "")
      : pathname.replace(/^\//, "");
  }

  function number(value: unknown) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }

  function compact(source: Source): Source | undefined {
    const result: Source = {};
    if (source.file) result.file = trimFile(source.file);
    if (source.file && source.line !== undefined) result.line = source.line;
    if (source.file && source.column !== undefined) {
      result.column = source.column;
    }
    if (source.component) result.component = source.component.slice(0, 120);
    return result.file || result.component ? result : undefined;
  }

  function fromAttributes(element: Element): Source | undefined {
    const host = element.closest(SOURCE_ATTRIBUTES);
    if (!host) return undefined;
    const read = (name: string) => host.getAttribute(name) ?? undefined;
    const component =
      read("data-sentry-component") ??
      read("data-component") ??
      read("data-inspector-component") ??
      undefined;
    const inline = read("data-source");
    if (inline) {
      const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(inline.trim());
      return compact({
        file: match?.[1] || inline,
        line: number(match?.[2]),
        column: number(match?.[3]),
        component,
      });
    }
    return compact({
      file:
        read("data-inspector-relative-path") ??
        read("data-source-file") ??
        read("data-sentry-source-file"),
      line: number(read("data-inspector-line") ?? read("data-source-line")),
      column: number(
        read("data-inspector-column") ?? read("data-source-column"),
      ),
      component,
    });
  }

  type Fiber = {
    type?: unknown;
    return?: Fiber | null;
    _debugOwner?: Fiber | null;
    _debugSource?: {
      fileName?: string;
      lineNumber?: number;
      columnNumber?: number;
    };
    _debugStack?: { stack?: string } | string;
  };

  function componentName(type: unknown): string | undefined {
    if (!type || typeof type === "string") return undefined;
    const value = type as {
      displayName?: string;
      name?: string;
      render?: { displayName?: string; name?: string };
      type?: unknown;
    };
    return (
      value.displayName ||
      value.name ||
      value.render?.displayName ||
      value.render?.name ||
      (value.type ? componentName(value.type) : undefined) ||
      undefined
    );
  }

  // First app frame of a React 19 `_debugStack`. Dev-server stacks are not
  // source-mapped, so only the file is trusted, not the line.
  function stackFile(stack: string | undefined) {
    for (const line of (stack ?? "").split("\n").slice(1)) {
      if (
        /node_modules|\/\.vite\/|react-dom|react-stack|jsx-dev-runtime|jsx-runtime|chunk-/.test(
          line,
        )
      ) {
        continue;
      }
      const match = /\(?((?:[a-z]+:\/\/)?[^\s()]+?):\d+:\d+\)?\s*$/i.exec(line);
      if (match) return match[1];
    }
    return undefined;
  }

  function fromReact(element: Element): Source | undefined {
    const key = Object.keys(element).find(
      (name) =>
        name.startsWith("__reactFiber$") ||
        name.startsWith("__reactInternalInstance$"),
    );
    if (!key) return undefined;
    const fiber = (element as unknown as Record<string, Fiber>)[key];
    let component = componentName(fiber?._debugOwner?.type);
    let source = fiber?._debugSource;
    let node: Fiber | null | undefined = fiber;
    for (let depth = 0; node && depth < 60; depth += 1) {
      component ??= componentName(node.type);
      source ??= node._debugSource;
      if (component && source) break;
      node = node.return;
    }
    if (source?.fileName) {
      return compact({
        file: source.fileName,
        line: number(source.lineNumber),
        column: number(source.columnNumber),
        component,
      });
    }
    const stack = fiber?._debugStack;
    return compact({
      file: stackFile(typeof stack === "string" ? stack : stack?.stack),
      component,
    });
  }

  function fromVue(element: Element): Source | undefined {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const instance = (
        node as unknown as {
          __vueParentComponent?: {
            type?: { __file?: string; name?: string; __name?: string };
          };
        }
      ).__vueParentComponent;
      if (instance?.type) {
        return compact({
          file: instance.type.__file,
          component: instance.type.name ?? instance.type.__name,
        });
      }
    }
    return undefined;
  }

  function fromSvelte(element: Element): Source | undefined {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const loc = (
        node as unknown as {
          __svelte_meta?: {
            loc?: { file?: string; line?: number; column?: number };
          };
        }
      ).__svelte_meta?.loc;
      if (loc?.file) {
        return compact({
          file: loc.file,
          line: number(loc.line),
          column: number(loc.column),
        });
      }
    }
    return undefined;
  }

  function sourceOf(element: Element): Source | undefined {
    for (const read of [fromAttributes, fromReact, fromVue, fromSvelte]) {
      try {
        const source = read(element);
        if (source) return source;
      } catch {
        // Source mapping is best effort.
      }
    }
    return undefined;
  }

  function visible(element: HTMLElement) {
    const check = (
      element as HTMLElement & {
        checkVisibility?: (options: object) => boolean;
      }
    ).checkVisibility;
    if (check) {
      return check.call(element, {
        opacityProperty: true,
        visibilityProperty: true,
      });
    }
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.opacity === "0") return false;
    }
    return getComputedStyle(element).visibility === "visible";
  }

  function hasOwnText(element: Element) {
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
        return true;
      }
    }
    return false;
  }

  const round = (value: number) =>
    Math.min(1, Math.max(0, Math.round(value * 1e5) / 1e5));
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const found: { index: number; primary: boolean; element: Mapped }[] = [];
  const all = document.body ? [...document.body.querySelectorAll("*")] : [];

  all.forEach((node, index) => {
    if (!(node instanceof HTMLElement || node instanceof SVGSVGElement)) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    const role = roleOf(node, tag);
    if (role === "presentation" || role === "none") return;
    const testId = node.getAttribute("data-testid") ?? undefined;
    const primary =
      Boolean(testId) ||
      node.matches(INTERACTIVE) ||
      node.matches(SOURCE_ATTRIBUTES) ||
      node.hasAttribute("role") ||
      /^h[1-6]$/.test(tag) ||
      tag === "img" ||
      (tag === "svg" && node.hasAttribute("aria-label")) ||
      LANDMARKS.has(tag) ||
      ((tag === "section" || tag === "form") && role !== undefined);
    if (!primary) {
      if (!(node instanceof HTMLElement) || !hasOwnText(node)) return;
      // An inline run of text counts only when its parent is not itself text.
      const display = getComputedStyle(node).display;
      if (display === "contents") return;
      if (
        display === "inline" &&
        node.parentElement &&
        hasOwnText(node.parentElement)
      ) {
        return;
      }
    }
    if (node instanceof HTMLElement && !visible(node)) return;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const left = Math.max(0, rect.left + scrollX);
    const top = Math.max(0, rect.top + scrollY);
    const right = Math.min(width, rect.right + scrollX);
    const bottom = Math.min(height, rect.bottom + scrollY);
    if (right <= left || bottom <= top) return;

    const mapped: Mapped = {
      box: {
        x: round(left / width),
        y: round(top / height),
        w: round((right - left) / width),
        h: round((bottom - top) / height),
      },
      tag,
      selector: selectorOf(node),
    };
    if (role) mapped.role = role;
    const name =
      node instanceof HTMLElement
        ? nameOf(node, tag, role)
        : clean(node.getAttribute("aria-label"));
    if (name) mapped.name = name;
    if (testId) mapped.testId = testId;
    const source = sourceOf(node);
    if (source) mapped.source = source;
    found.push({ index, primary, element: mapped });
  });

  // Over the cap, keep meaningful elements before plain text blocks.
  let kept = found;
  if (found.length > LIMIT) {
    const primary = found.filter((item) => item.primary);
    const text = found.filter((item) => !item.primary);
    kept = [...primary, ...text]
      .slice(0, LIMIT)
      .sort((left, right) => left.index - right.index);
  }

  const map: ElementMap = {
    version: 1,
    capture: { width, height },
    elements: kept.map((item) => item.element),
  };
  if (/^(https?|file):/.test(location.href)) map.url = location.href;
  return map;
}

// The parts of a Playwright Page this needs, so any Playwright version works.
export type CapturePage = {
  evaluate<R>(pageFunction: (() => R) | string): Promise<R>;
  screenshot(options?: object): Promise<Uint8Array>;
};

export type CaptureOptions = {
  path?: string;
  // Element map beside the capture: on by default when `path` is set, at
  // `<path without extension>.elements.json`. `false` skips it.
  elements?: boolean | { path?: string };
  // Accessibility findings beside the capture (`<path>.a11y.json`): off by
  // default. Needs the optional `axe-core` package; without it the check is
  // skipped and `a11yNotice` says so.
  a11y?: boolean | A11yCaptureOption;
  // Anything else goes to Playwright's `page.screenshot`.
  [option: string]: unknown;
};

export type CaptureResult = PinnedChromeReport & {
  image: Uint8Array;
  elements: ElementMap | null;
  a11y: A11yReport | null;
  // Set when the accessibility check was asked for but skipped.
  a11yNotice?: string;
};

// `shots/checkout.png` -> `shots/checkout.elements.json`. The same rule as
// elementMapPathFor in shared/elements (a test keeps them equal); it is
// repeated so plain `node` scripts can import this file, which only allows
// type imports of extensionless paths.
export function elementMapPath(capturePath: string) {
  return `${capturePath.replace(/\.[^./\\]*$/, "")}.elements.json`;
}

export async function captureFullPage(
  page: CapturePage,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const {
    elements: elementsOption,
    a11y: a11yOption,
    ...screenshotOptions
  } = options;
  const { pinned } = await page.evaluate(pinBottomChromeInPage);
  try {
    const image = await page.screenshot({
      ...screenshotOptions,
      fullPage: true,
    });
    const a11y = await captureA11y(page, a11yOption, options.path).catch(
      (error: unknown) => ({
        a11y: null,
        a11yNotice: `Accessibility checks failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    if (elementsOption === false)
      return { image, pinned, elements: null, ...a11y };
    const elements = await page.evaluate(collectElementsInPage);
    const target =
      typeof elementsOption === "object" && elementsOption.path
        ? elementsOption.path
        : typeof options.path === "string"
          ? elementMapPath(options.path)
          : null;
    if (target) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(elements, null, 2)}\n`);
    }
    return { image, pinned, elements, ...a11y };
  } finally {
    await page.evaluate(restoreBottomChromeInPage);
  }
}

// ---------------------------------------------------------------------------
// Accessibility checks (axe-core), run while the bars are re-pinned so boxes
// match the shot. The in-page code is a string, so bundler-added helpers
// (esbuild's keepNames `__name`) never reach the page.

export type A11yCaptureOption = {
  path?: string;
  // Resolves axe-core's browser source, or null when it isn't installed.
  loadAxe?: () => Promise<string | null>;
};

export const AXE_MISSING_NOTICE =
  "Accessibility checks skipped: axe-core is not installed (npm i -D axe-core).";

// `shots/checkout.png` -> `shots/checkout.a11y.json` (a11yReportPathFor in
// shared/a11y, repeated for the same reason as elementMapPath).
export function a11yReportPath(capturePath: string) {
  return `${capturePath.replace(/\.[^./\\]*$/, "")}.a11y.json`;
}

export async function loadAxeSource(
  load: () => Promise<{
    source?: unknown;
    default?: { source?: unknown };
  }> = () => import("axe-core") as never,
): Promise<string | null> {
  try {
    const axe = await load();
    const source = axe.source ?? axe.default?.source;
    return typeof source === "string" ? source : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

const AXE_NODE_LIMIT = 50;
const AXE_SUMMARY_MAX = 300;

// Returns RawA11y. Plain ES2017 so it runs as-is in any page.
const RUN_AXE_IN_PAGE = `(async function () {
  var results = await window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    resultTypes: ["violations"]
  });
  var docElement = document.documentElement;
  var scroller = document.scrollingElement || docElement;
  var body = document.body;
  var width = Math.max(scroller.scrollWidth, body ? body.scrollWidth : 0, docElement.clientWidth, 1);
  var height = Math.max(scroller.scrollHeight, body ? body.scrollHeight : 0, docElement.clientHeight, 1);
  var sx = window.scrollX, sy = window.scrollY;
  function flat(target) {
    return [].concat.apply([], target.map(function (part) {
      return Array.isArray(part) ? flat(part) : [String(part)];
    }));
  }
  function rectOf(target) {
    if (target.length !== 1 || typeof target[0] !== "string") return null;
    try {
      var element = document.querySelector(target[0]);
      if (!element) return null;
      var r = element.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { left: r.left + sx, top: r.top + sy, right: r.right + sx, bottom: r.bottom + sy };
    } catch (error) {
      return null;
    }
  }
  return {
    engine: { name: "axe-core", version: String(window.axe.version || "") },
    capture: { width: width, height: height },
    url: /^(https?|file):/.test(location.href) ? location.href : undefined,
    violations: results.violations.map(function (v) {
      return {
        id: v.id, impact: v.impact || null, help: v.help, helpUrl: v.helpUrl,
        description: v.description,
        nodes: v.nodes.slice(0, ${AXE_NODE_LIMIT}).map(function (n) {
          return { target: flat(n.target).join(" >>> "), rect: rectOf(n.target), summary: n.failureSummary || undefined };
        })
      };
    })
  };
})()`;

type Rect = { left: number; top: number; right: number; bottom: number };

export type RawA11y = {
  engine?: { name: string; version: string };
  capture: { width: number; height: number };
  url?: string;
  violations: {
    id: string;
    impact?: string | null;
    help: string;
    helpUrl?: string;
    description?: string;
    nodes: { target: string; rect?: Rect | null; summary?: string }[];
  }[];
};

// A document-pixel rect as fractions of the capture: the same clamping and
// rounding collectElementsInPage uses for element-map boxes.
export function captureFractionBox(
  rect: Rect,
  capture: { width: number; height: number },
) {
  const round = (value: number) =>
    Math.min(1, Math.max(0, Math.round(value * 1e5) / 1e5));
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(capture.width, rect.right);
  const bottom = Math.min(capture.height, rect.bottom);
  if (right <= left || bottom <= top) return undefined;
  const box = {
    x: round(left / capture.width),
    y: round(top / capture.height),
    w: round((right - left) / capture.width),
    h: round((bottom - top) / capture.height),
  };
  return box.w > 0 && box.h > 0 ? box : undefined;
}

const IMPACTS = new Set(["minor", "moderate", "serious", "critical"]);

export function toA11yReport(raw: RawA11y): A11yReport {
  const report: A11yReport = {
    version: 1,
    ...(raw.engine ? { engine: raw.engine } : {}),
    capture: raw.capture,
    ...(raw.url ? { url: raw.url } : {}),
    violations: raw.violations.map((violation) => ({
      id: violation.id,
      impact: IMPACTS.has(violation.impact ?? "")
        ? (violation.impact as A11yReport["violations"][number]["impact"])
        : null,
      help: violation.help,
      ...(violation.helpUrl ? { helpUrl: violation.helpUrl } : {}),
      ...(violation.description ? { description: violation.description } : {}),
      nodes: violation.nodes.map((node) => {
        const box = node.rect
          ? captureFractionBox(node.rect, raw.capture)
          : undefined;
        const summary = node.summary?.replace(/\s+/g, " ").trim();
        return {
          target: node.target,
          ...(box ? { box } : {}),
          ...(summary
            ? {
                summary:
                  summary.length > AXE_SUMMARY_MAX
                    ? `${summary.slice(0, AXE_SUMMARY_MAX - 1)}…`
                    : summary,
              }
            : {}),
        };
      }),
    })),
  };
  return report;
}

async function captureA11y(
  page: CapturePage,
  option: CaptureOptions["a11y"],
  capturePath: unknown,
): Promise<Pick<CaptureResult, "a11y" | "a11yNotice">> {
  if (!option) return { a11y: null };
  const settings = typeof option === "object" ? option : {};
  const source = await (settings.loadAxe ?? (() => loadAxeSource()))();
  if (!source) return { a11y: null, a11yNotice: AXE_MISSING_NOTICE };
  const present = await page.evaluate<boolean>(
    "typeof window.axe === 'object' && typeof window.axe.run === 'function'",
  );
  if (!present) await page.evaluate(`${source}\n;void 0`);
  const report = toA11yReport(await page.evaluate<RawA11y>(RUN_AXE_IN_PAGE));
  const target =
    settings.path ??
    (typeof capturePath === "string" ? a11yReportPath(capturePath) : null);
  if (target) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  return { a11y: report };
}
