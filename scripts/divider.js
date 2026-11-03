import { isNote } from "./constants.js";

/**
 * Divider: a line that is only `---` (three or more dashes) becomes a horizontal rule.
 * Core chat turns newlines into <br>, so a "line" is whatever sits between <br>s (or newlines from the edit
 * dialog). The line breaks around the rule are dropped: <hr> is a block and would leave empty lines.
 */

const HR = '<hr class="gct-divider">';
const SEP = /(<br\s*\/?>|\n)/i;
const RULE = /^\s*-{3,}\s*$/;
// Foundry's HTML cleaning stores the rule as `<hr class="gct-divider" />`.
const HR_STORED = /<hr class="gct-divider"\s*\/?>/g;

/** Convert `---` lines in a string to <hr> HTML. */
export function markupToDivider(html) {
  if (typeof html !== "string" || !html.includes("---")) return html;
  // Odd indices are the separators, even indices the lines between them.
  const parts = html.split(SEP);
  let changed = false;
  for (let i = 0; i < parts.length; i += 2) {
    if (!RULE.test(parts[i])) continue;
    parts[i] = HR;
    if (i > 0) parts[i - 1] = "";
    if (i + 1 < parts.length) parts[i + 1] = "";
    changed = true;
  }
  return changed ? parts.join("") : html;
}

/** Convert this module's <hr> back to `---` lines (for editing). */
export function dividerToMarkup(html) {
  if (typeof html !== "string" || !html.includes("gct-divider")) return html;
  return html.replace(HR_STORED, "<br>---<br>").replace(/^<br>/, "").replace(/<br>$/, "");
}

/** preCreateChatMessage: store the rule as HTML so every client, archive and export renders it. */
export function onPreCreateChatMessageDivider(message) {
  if (isNote(message)) return; // notes stay plain text
  const content = message._source?.content;
  const converted = markupToDivider(content);
  if (converted !== content) message.updateSource({ content: converted });
}

/** preUpdateChatMessage: edits that use the markup are converted too. */
export function onPreUpdateChatMessageDivider(message, changes) {
  if (typeof changes?.content !== "string" || isNote(message)) return;
  const converted = markupToDivider(changes.content);
  if (converted !== changes.content) changes.content = converted;
}
