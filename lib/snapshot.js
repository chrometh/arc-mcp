// lib/snapshot.js — compact semantic page snapshot
//
// Replaces blind CSS targeting. Returns a markdown summary listing
// interactive elements (buttons, links, inputs, etc.) grouped by role,
// plus first main-content text and a compact form outline.
//
// Claude reads the snapshot ONCE, then can click/type by role+name
// without guessing selectors.

import { getCDPSession } from "./attach.js";

const MAX_ITEMS_PER_GROUP = 40;
const MAX_TEXT_PREVIEW = 1000;

/**
 * Produce a compact semantic snapshot of a page.
 * Returns a markdown string.
 */
export async function pageSnapshot(page, { includeHidden = false, textPreview = true } = {}) {
  const url = page.url();
  let title = "";
  try { title = await page.title(); } catch {}

  // Raw CDP AX tree for comprehensive semantic info
  const session = await getCDPSession(page);
  const { nodes } = await session.send("Accessibility.getFullAXTree");

  // Group nodes by role. Only include nodes with name (unnamed = not interactive typically).
  const groups = {
    heading: [],
    link: [],
    button: [],
    textbox: [],
    searchbox: [],
    combobox: [],
    checkbox: [],
    radio: [],
    tab: [],
    menuitem: [],
    option: [],
  };

  for (const node of nodes) {
    const role = node.role?.value;
    const name = node.name?.value;
    if (!role || !name) continue;
    if (!groups[role]) continue;
    if (!includeHidden && node.ignored) continue;
    if (groups[role].length >= MAX_ITEMS_PER_GROUP) continue;
    groups[role].push(name);
  }

  // Forms — enumerate inputs per form if any
  const formCount = await page.locator("form").count().catch(() => 0);

  const lines = [];
  lines.push(`# Page Snapshot`);
  lines.push(``);
  lines.push(`**URL**: ${url}`);
  lines.push(`**Title**: ${title}`);
  lines.push(``);

  // Headings — structural outline
  if (groups.heading.length) {
    lines.push(`## Headings (${groups.heading.length})`);
    for (const h of groups.heading.slice(0, 15)) lines.push(`- ${h}`);
    if (groups.heading.length > 15) lines.push(`- …${groups.heading.length - 15} more`);
    lines.push(``);
  }

  // Interactive — buttons, links, inputs
  const mkGroup = (title, items, prefix = "") => {
    if (!items.length) return;
    lines.push(`## ${title} (${items.length})`);
    for (const it of items) lines.push(`- ${prefix}${it}`);
    lines.push(``);
  };

  mkGroup("Buttons", groups.button);
  mkGroup("Links", groups.link);

  const inputRoles = [
    ["Text inputs", groups.textbox],
    ["Search inputs", groups.searchbox],
    ["Dropdowns (combobox)", groups.combobox],
    ["Checkboxes", groups.checkbox],
    ["Radios", groups.radio],
  ];
  for (const [t, items] of inputRoles) mkGroup(t, items);

  mkGroup("Tabs", groups.tab);
  mkGroup("Menu items", groups.menuitem);

  if (formCount > 0) {
    lines.push(`## Forms`);
    lines.push(`${formCount} \`<form>\` element${formCount === 1 ? "" : "s"} on page.`);
    lines.push(``);
  }

  if (textPreview) {
    let main = "";
    try {
      main = await page.evaluate(() => {
        const el = document.querySelector("main, article, [role=main], #main, .main") || document.body;
        return (el.innerText || "").slice(0, 4000);
      });
    } catch {}
    if (main) {
      const preview = main.slice(0, MAX_TEXT_PREVIEW).trim();
      lines.push(`## Text (first ${Math.min(preview.length, MAX_TEXT_PREVIEW)} chars of main)`);
      lines.push(``);
      lines.push(preview);
      if (main.length > MAX_TEXT_PREVIEW) lines.push(`\n…(${main.length - MAX_TEXT_PREVIEW} more chars)`);
      lines.push(``);
    }
  }

  lines.push(`---`);
  lines.push(`Click elements above by role + name. Example: { role: "button", name: "Add to cart" }`);

  return lines.join("\n");
}

/**
 * Short snapshot — URL, title, counts only. For cheap page-status checks.
 */
export async function pageInfo(page) {
  const url = page.url();
  let title = "";
  try { title = await page.title(); } catch {}
  let btnCount = 0, linkCount = 0;
  try { btnCount = await page.getByRole("button").count(); } catch {}
  try { linkCount = await page.getByRole("link").count(); } catch {}
  return { url, title, btnCount, linkCount };
}
