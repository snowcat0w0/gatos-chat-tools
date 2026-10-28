import { addChatControl } from "./lib.js";

/*
 * The module's own row inside #chat-controls. Core keeps its message-mode buttons (and, for the GM, the
 * save/clear buttons) on the first line; every button this module adds goes on a second, full-width line
 * (`.gct-controls-row`, CSS in chat-tools.css) so they are all visible at the sidebar's default width.
 * The row is a child of #chat-controls, so it travels with it (sidebar, popout, collapsed notifications).
 */

export const ROW_CLASS = "gct-controls-row";

/** The row element (created on first use; idempotent). */
export function chatToolsRow(controls = document.getElementById("chat-controls")) {
  if (!controls) return null;
  let row = controls.querySelector(`:scope > .${ROW_CLASS}`);
  if (!row) {
    row = document.createElement("div");
    row.className = ROW_CLASS;
    controls.append(row);
  }
  return row;
}

/** gatos-lib addChatControl, but into the module's row. Same options; `position` is relative to the row. */
export function addToolsButton({ controls, ...options } = {}) {
  const row = chatToolsRow(controls);
  if (!row) return null;
  return addChatControl({ ...options, controls: row });
}
