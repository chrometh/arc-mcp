// lib/locators.js — resolve a locator spec to a Playwright Locator.
//
// Locator spec shape (any one or combo):
//   { role: "button", name: "Add to cart" }     ← Playwright getByRole
//   { text: "Add to cart" }                     ← Playwright getByText
//   { label: "Email address" }                  ← Playwright getByLabel
//   { placeholder: "you@email.com" }            ← Playwright getByPlaceholder
//   { testid: "add-to-cart" }                   ← Playwright getByTestId
//   { css: "button.primary" }                   ← raw CSS selector
//   { xpath: "//button[@aria-label='X']" }      ← raw XPath
//   Any of the above + { index: 2 }             ← pick nth match if ambiguous
//   Any of the above + { nth: 2 }               ← alias for index
//
// Strict-by-default: if locator matches >1 element and no index given, we fail loudly.
// Auto-wait: Playwright actions auto-wait up to 30s default for actionability.

const KNOWN_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button",
  "caption", "cell", "checkbox", "code", "columnheader", "combobox", "complementary",
  "contentinfo", "definition", "deletion", "dialog", "directory", "document", "emphasis",
  "feed", "figure", "form", "generic", "grid", "gridcell", "group", "heading", "img",
  "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee", "math",
  "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "navigation",
  "none", "note", "option", "paragraph", "presentation", "progressbar", "radio",
  "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox",
  "separator", "slider", "spinbutton", "status", "strong", "subscript", "superscript",
  "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "time", "timer",
  "toolbar", "tooltip", "tree", "treegrid", "treeitem"
]);

/**
 * Resolve a locator spec to a Playwright Locator on the given page.
 * Returns { locator, strategy } — strategy for debugging.
 */
export function resolveLocator(page, spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("Locator spec required. Provide { role, name } or { text } or { css } etc.");
  }

  const { role, name, text, label, placeholder, testid, css, xpath, index, nth } = spec;
  const idx = typeof index === "number" ? index : (typeof nth === "number" ? nth : null);

  let loc;
  let strategy;

  if (role) {
    if (!KNOWN_ROLES.has(role.toLowerCase())) {
      // Still allow — user may know a custom role. Warn in strategy.
      strategy = `getByRole("${role}", { name: ${JSON.stringify(name ?? null)} }) [warning: unknown ARIA role]`;
    } else {
      strategy = `getByRole("${role}", { name: ${JSON.stringify(name ?? null)} })`;
    }
    loc = page.getByRole(role, name ? { name } : undefined);
  } else if (testid) {
    loc = page.getByTestId(testid);
    strategy = `getByTestId("${testid}")`;
  } else if (label) {
    loc = page.getByLabel(label);
    strategy = `getByLabel("${label}")`;
  } else if (placeholder) {
    loc = page.getByPlaceholder(placeholder);
    strategy = `getByPlaceholder("${placeholder}")`;
  } else if (text) {
    loc = page.getByText(text);
    strategy = `getByText("${text}")`;
  } else if (name) {
    // name without role: form-input strategies first (labels/placeholders/textbox),
    // then interactive elements (buttons/links). Most common use case is typing into
    // labeled form fields, so label first.
    loc = page.getByLabel(name, { exact: false })
      .or(page.getByPlaceholder(name))
      .or(page.getByRole("textbox", { name }))
      .or(page.getByRole("searchbox", { name }))
      .or(page.getByRole("combobox", { name }))
      .or(page.getByRole("button", { name }))
      .or(page.getByRole("link", { name }));
    strategy = `fallback(label|placeholder|textbox|searchbox|combobox|button|link) for name="${name}"`;
  } else if (css) {
    loc = page.locator(css);
    strategy = `locator("${css}")`;
  } else if (xpath) {
    loc = page.locator(`xpath=${xpath}`);
    strategy = `xpath(${xpath})`;
  } else {
    throw new Error("Locator spec needs at least one of: role, name, text, label, placeholder, testid, css, xpath.");
  }

  if (idx !== null) {
    loc = loc.nth(idx);
    strategy += ` .nth(${idx})`;
  }

  return { locator: loc, strategy };
}

/**
 * Check how many elements match. Useful for disambiguating before clicking.
 */
export async function countMatches(page, spec) {
  const { locator } = resolveLocator(page, spec);
  return await locator.count();
}
