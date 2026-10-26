import { fmtDate, fmtTime } from "./constants.js";

/*
 * Small helpers shared by the floating panels (notes.js, whisper-panel.js): a composer that sends on Enter,
 * list refreshes that keep the scroll position, and a compact time label.
 */

/** Is a scroll container within `slack` px of its bottom? */
export function nearBottom(el, slack = 40) {
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/**
 * Replace a scroll container's content with `apply()` while keeping what the user looks at: stick to the
 * bottom only when it already was near the bottom, otherwise keep the scroll offset. With `anchorTop`
 * (content prepended above, e.g. "load older"), keep the distance from the bottom instead.
 */
export async function keepScroll(el, apply, { anchorTop = false } = {}) {
  if (!el) return apply();
  const stick = nearBottom(el);
  const fromBottom = el.scrollHeight - el.scrollTop;
  const top = el.scrollTop;
  await apply();
  if (anchorTop) el.scrollTop = el.scrollHeight - fromBottom;
  else if (stick) el.scrollTop = el.scrollHeight;
  else el.scrollTop = top;
}

/**
 * Enter sends, Shift+Enter inserts a line break, IME composition is left alone.
 * @param {HTMLTextAreaElement} textarea
 * @param {() => any} onSend
 */
export function bindComposer(textarea, onSend) {
  if (!textarea || textarea.dataset.gctComposer) return;
  textarea.dataset.gctComposer = "1";
  textarea.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    ev.stopPropagation();
    onSend();
  });
}

/** "14:05" today, "2026-10-25 14:05" otherwise. */
export function shortTime(ts) {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? fmtTime(ts) : `${fmtDate(ts)} ${fmtTime(ts)}`;
}

/** A user's colour as a CSS string (for author names). */
export function userColor(user) {
  const c = user?.color;
  if (!c) return "";
  return c.css ?? String(c);
}
