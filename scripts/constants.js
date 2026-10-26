import { defineModule } from "./lib.js";

export const MODULE_ID = "gatos-chat-tools";

export const TEMPLATES = {
  viewer: `modules/${MODULE_ID}/templates/viewer.hbs`,
  messages: `modules/${MODULE_ID}/templates/message-list.hbs`,
  edit: `modules/${MODULE_ID}/templates/edit-dialog.hbs`,
  save: `modules/${MODULE_ID}/templates/save-dialog.hbs`,
  delete: `modules/${MODULE_ID}/templates/delete-dialog.hbs`,
  export: `modules/${MODULE_ID}/templates/export-dialog.hbs`,
};

/** Templates registered as named Handlebars partials. */
export const PARTIALS = {
  gctSourceRow: `modules/${MODULE_ID}/templates/source-row.hbs`,
};

/** Library handle: `mod.L("Viewer.Title")` = `game.i18n.localize("GCT.Viewer.Title")`, settings under `GCT.Settings`. */
export const mod = defineModule(MODULE_ID, { langPrefix: "GCT" });

/** Localize a key under the GCT namespace, formatting with data when given. */
export const L = mod.L;

/**
 * Is this message (document or serialized archive entry) a shared note (notes.js)? Notes are public chat
 * messages kept out of the chat log, the archive, exports and every count of "chat messages".
 */
export const isNote = (message) => !!(message?.flags?.[MODULE_ID]?.note || message?.note);

/** Date helpers (gatos-lib util/time, ported from this file): yyyy-mm-dd, yyyy-mm-dd HH:MM:SS, HH:MM, day bounds, <input type="date"> parsing. */
export { fmtDate, fmtDateTime, fmtTime, startOfDay, endOfDay, parseDateInput } from "./lib.js";
