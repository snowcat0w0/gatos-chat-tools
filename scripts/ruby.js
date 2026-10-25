/**
 * Ruby (furigana-style) annotation: `[[base|reading]]` ↔ `<ruby>base<rp>(</rp><rt>reading</rt><rp>)</rp></ruby>`.
 * The pipe is required, so inline rolls such as `[[1d20]]` or `[[/r 1d6]]` are never touched.
 */

const MARKUP = /\[\[([^[\]|\n]+?)\|([^[\]|\n]+?)\]\]/g;
const RUBY = /<ruby>([\s\S]*?)<rp>\(<\/rp><rt>([\s\S]*?)<\/rt><rp>\)<\/rp><\/ruby>/g;

/** Convert `[[base|reading]]` markup in a string to <ruby> HTML. */
export function markupToRuby(text) {
  if (typeof text !== "string" || !text.includes("[[")) return text;
  return text.replace(MARKUP, (_, base, rt) => `<ruby>${base.trim()}<rp>(</rp><rt>${rt.trim()}</rt><rp>)</rp></ruby>`);
}

/** Convert <ruby> HTML produced by this module back to `[[base|reading]]` markup (for editing). */
export function rubyToMarkup(html) {
  if (typeof html !== "string" || !html.includes("<ruby>")) return html;
  return html.replace(RUBY, (_, base, rt) => `[[${base}|${rt}]]`);
}

/** preCreateChatMessage: store ruby as HTML so every client, archive and export renders it. */
export function onPreCreateChatMessageRuby(message) {
  const content = message._source?.content;
  const converted = markupToRuby(content);
  if (converted !== content) message.updateSource({ content: converted });
}

/** preUpdateChatMessage: edits that use the markup are converted too. */
export function onPreUpdateChatMessageRuby(message, changes) {
  if (typeof changes?.content !== "string") return;
  const converted = markupToRuby(changes.content);
  if (converted !== changes.content) changes.content = converted;
}
