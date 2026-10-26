import { mod } from "./constants.js";

/*
 * The v13 chat input `#chat-message` is a plain <textarea> (templates/sidebar/tabs/chat/notifications.hbs).
 * ChatLog creates it once and moves the same element between the sidebar / popout `.chat-form` and
 * `#chat-notifications` (ChatLog#_toggleNotifications), so listeners bound to it survive the moves.
 * User edits fire `input` events; programmatic value changes do not: ChatLog#sendMessage clears the value after
 * a message is processed (covered by our createChatMessage hook) and history recall (ArrowUp / ArrowDown) sets
 * it directly (picked up by the next keystroke).
 */

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

/** Call fn() whenever the user edits the chat input's text. */
export function onChatInputChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Listen for edits of the chat textarea (module load time; delegated, so it works before the input exists). */
export function registerChatInputCapture() {
  document.addEventListener(
    "input",
    (ev) => {
      if (ev.target?.id === "chat-message") notify();
    },
    true
  );
}

/** The chat input element (`<textarea id="chat-message">`), wherever it currently is. */
export function chatInputElement() {
  return document.getElementById("chat-message");
}

/** Plain text of an HTML string without executing or loading anything (DOMParser documents are inert). */
export function htmlToPlain(html) {
  const s = String(html ?? "");
  if (!s) return "";
  const doc = new DOMParser().parseFromString(`<body>${s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p\b[^>]*>/gi, "\n")}</body>`, "text/html");
  return doc.body.textContent ?? "";
}

/** The chat input's current text (the textarea value). */
export function chatInputText() {
  return String(chatInputElement()?.value ?? "");
}

/**
 * Wrap the current selection of the chat textarea in `open … close`, or insert `open close` with the caret
 * between them when nothing is selected. Inserted with the browser's editing command so Ctrl+Z undoes it and an
 * `input` event fires; falls back to setRangeText (plus a synthetic `input` event) when the command is refused.
 * @returns {"ok"|"multiline"|"brace"|"none"}
 */
export function wrapChatSelection(open, close) {
  const input = chatInputElement();
  if (!(input instanceof HTMLTextAreaElement)) return "none";
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const inner = input.value.slice(start, end);
  if (/[\r\n]/.test(inner)) return "multiline";
  if (/[{}]/.test(inner)) return "brace";
  const text = `${open}${inner}${close}`;
  input.focus();
  input.setSelectionRange(start, end);
  // execCommand is deprecated but still the only way to insert text into a textarea undoably.
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (!inserted || input.value.slice(start, start + text.length) !== text) {
    input.setRangeText(text, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const caret = inner ? start + text.length : start + open.length;
  input.setSelectionRange(caret, caret);
  return "ok";
}
