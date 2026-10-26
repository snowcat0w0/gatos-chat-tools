import { mod } from "./constants.js";

/*
 * The v14 chat input `#chat-message` is a <prose-mirror> element whose editor (and EditorView) is private.
 * Core announces every editor it builds with the `createProseMirrorEditor` hook, passing the plugin record by
 * reference; the chat log's editor is the one carrying ChatLog's own `chatInput` plugin. We add a small plugin
 * there to capture the view and to hear every document change, including programmatic ones (the input being
 * cleared after a message is sent, history recall, text inserted by modules). The element destroys and rebuilds
 * its editor whenever it is moved (sidebar ↔ popout ↔ notifications), and the hook fires again each time.
 */

/** @type {import("prosemirror-view").EditorView|null} */
let view = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      mod.error("chat input listener failed", err);
    }
  }
}

/** Call fn() whenever the chat input's text changes (typing, clearing, programmatic edits). */
export function onChatInputChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Register the createProseMirrorEditor hook (module load time, before the chat log renders its input). */
export function registerChatInputCapture() {
  Hooks.on("createProseMirrorEditor", (uuid, plugins) => {
    if (!plugins?.chatInput || plugins.gctChatInput) return;
    const Plugin = foundry.prosemirror?.Plugin;
    if (!Plugin) return;
    plugins.gctChatInput = new Plugin({
      view: (editorView) => {
        view = editorView;
        return {
          update: (v, prevState) => {
            if (!v.state.doc.eq(prevState.doc)) notify();
          },
          destroy: () => {
            if (view === editorView) view = null;
          },
        };
      },
    });
  });
}

/** The chat input element (`<prose-mirror id="chat-message">`), wherever it currently is. */
export function chatInputElement() {
  return document.getElementById("chat-message");
}

/** The live EditorView of the chat input, or null (not captured yet, or destroyed by a move). */
export function chatInputView() {
  return view?.dom?.isConnected ? view : null;
}

/** Plain text of an HTML string without executing or loading anything (DOMParser documents are inert). */
export function htmlToPlain(html) {
  const s = String(html ?? "");
  if (!s) return "";
  const doc = new DOMParser().parseFromString(`<body>${s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p\b[^>]*>/gi, "\n")}</body>`, "text/html");
  return doc.body.textContent ?? "";
}

/** The chat input's current text: the editor document when captured, else the editor DOM, else its serialized value. */
export function chatInputText() {
  const v = chatInputView();
  if (v) return v.state.doc.textBetween(0, v.state.doc.content.size, "\n", " ");
  const input = chatInputElement();
  const editable = input?.querySelector(".ProseMirror");
  if (editable) return editable.textContent ?? "";
  return htmlToPlain(input?.value);
}

/**
 * Wrap the current selection of the chat input in `open … close`, or insert `open close` with the caret
 * between them when nothing is selected. Uses the editor's own transaction when the view is captured,
 * otherwise falls back to `insertText` on the focused editor.
 * @returns {"ok"|"multiline"|"brace"|"none"}
 */
export function wrapChatSelection(open, close) {
  const v = chatInputView();
  if (v) {
    const { state } = v;
    const { from, to, empty, $from, $to } = state.selection;
    if (!empty && !$from.sameParent($to)) return "multiline";
    const inner = empty ? "" : state.doc.textBetween(from, to, " ");
    if (/[{}]/.test(inner)) return "brace";
    let tr = state.tr.insertText(`${open}${inner}${close}`, from, to);
    const caret = empty ? from + open.length : from + open.length + inner.length + close.length;
    const TextSelection = foundry.prosemirror?.TextSelection;
    if (TextSelection) tr = tr.setSelection(TextSelection.create(tr.doc, caret));
    v.dispatch(tr.scrollIntoView());
    v.focus();
    return "ok";
  }

  // Fallback: the browser's editing command on the focused contenteditable (ProseMirror reads the DOM change).
  const input = chatInputElement();
  if (!input) return "none";
  input.focus();
  const selection = window.getSelection();
  const inner = selection && input.contains(selection.anchorNode) ? selection.toString() : "";
  if (inner.includes("\n")) return "multiline";
  if (/[{}]/.test(inner)) return "brace";
  // execCommand is deprecated but still the only way to insert text into a foreign contenteditable undoably.
  document.execCommand("insertText", false, `${open}${inner}${close}`);
  if (!inner) for (let i = 0; i < close.length; i++) selection?.modify?.("move", "backward", "character");
  return "ok";
}
