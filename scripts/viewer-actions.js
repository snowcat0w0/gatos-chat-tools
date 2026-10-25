/**
 * Extra buttons other modules add to the archive viewer (e.g. gatos-visual-novel's "replay as novel").
 * A button acts on the messages the viewer currently lists (after filters), or — in the selection
 * bar — on the selected ones. Messages are serialized objects with rendered `html`.
 * Backed by gatos-lib `actionRegistry`, which fires `gctViewerActionsChanged` on every change (as 0.5.2 did).
 */
import { actionRegistry } from "./lib.js";

const actions = actionRegistry("gctViewerActionsChanged");

/**
 * Register a viewer button. Re-registering an id replaces it.
 * @param {object} action
 * @param {string} action.id
 * @param {string} action.label             Localization key or text.
 * @param {string} [action.icon]            Font Awesome classes.
 * @param {string} [action.tooltip]         Localization key or text.
 * @param {boolean} [action.selection=true] Also offer the button in the selection bar.
 * @param {() => boolean} [action.visible]  Hide the button when it returns false.
 * @param {(messages: object[], meta: {title: string, source: string, selection: boolean}) => any} action.callback
 */
export function registerViewerAction(action) {
  if (!action?.id || typeof action.callback !== "function") throw new Error("registerViewerAction needs an id and a callback");
  actions.register(action);
}

/** The registered actions visible to the current user. */
export function viewerActions() {
  return actions.list();
}

export const getViewerAction = (id) => actions.get(id);
