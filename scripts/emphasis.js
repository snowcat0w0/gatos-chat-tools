import { isBalanced } from "./font-styles-markup.js";

/**
 * Emphasis: `*italic*` ↔ `<em>`, `**bold**` ↔ `<strong>`, `***bold italic***` ↔ `<strong><em>`.
 *
 * Pure functions with no Foundry globals, so they can be unit-tested in Node. Deliberately simpler than
 * Markdown: an opening and a closing run must have the same length (1–3) and sit on the same line, the text
 * between them must hold a letter or a digit (`*^^*` stays an emoticon) and balanced inline tags. Nesting works
 * when the lengths differ (`**bold *both* bold**`). A run opens when a non-space follows it and closes when a
 * non-space precedes it, so Korean particles may follow directly (`**강조**는`).
 *
 * Never touched: HTML tags and their attributes, `<code>` / `<pre>`, inline rolls `[[…]]`, enrichers
 * `@UUID[…]{…}`, URLs, a run between two digits (`2*3`), and `\*` (which becomes a plain `*`).
 */

const BLOCK_TAGS = "p|div|li|ul|ol|h[1-6]|blockquote|table|thead|tbody|tr|td|th|section|article|header|footer|hr|details|summary|figure";

/** Every character of the input lands in exactly one token (the last alternative takes any single character). */
const TOKEN = new RegExp(
  [
    // Opaque: never looked into, counts as one visible character.
    String.raw`(?<atom><code\b[^>]*>[\s\S]*?<\/code\s*>|\[\[[^\]\n]*\]{2,3}(?:\{[^}\n]*\})?|@[A-Za-z][\w.]*\[[^\]\n]*\](?:\{[^}\n]*\})?|https?:\/\/[^\s<]+)`,
    // Line and block boundaries: emphasis never crosses them.
    String.raw`(?<brk><pre\b[^>]*>[\s\S]*?<\/pre\s*>|\n|<br\b[^>]*>|<\/?(?:${BLOCK_TAGS})\b[^>]*>)`,
    // Inline tags: transparent when looking for the neighbouring character.
    String.raw`(?<tag><\/?[a-zA-Z][^>]*>)`,
    String.raw`(?<esc>\\\*)`,
    String.raw`(?<run>\*+)`,
    String.raw`(?<ent>&[a-zA-Z0-9#]+;)`,
    String.raw`(?<text>[^<\n\[@h&\\*]+|[\s\S])`,
  ].join("|"),
  "gi"
);

const OPEN = { 1: "<em>", 2: "<strong>", 3: "<strong><em>" };
const CLOSE = { 1: "</em>", 2: "</strong>", 3: "</em></strong>" };
const TAG_MARKUP = { "<em>": "*", "</em>": "*", "<strong>": "**", "</strong>": "**" };
const SPACE_ENTITY = /^&(?:nbsp|ensp|emsp|thinsp|#160|#xa0);$/i;

function tokenize(html) {
  const tokens = [];
  for (const m of html.matchAll(TOKEN)) {
    const g = m.groups;
    const type = g.atom !== undefined ? "atom" : g.brk !== undefined ? "brk" : g.tag !== undefined ? "tag" : g.esc !== undefined ? "esc" : g.run !== undefined ? "run" : g.ent !== undefined ? "ent" : "text";
    tokens.push({ type, raw: m[0] });
  }
  return tokens;
}

/** The character next to token `i` in direction `dir`, seen through inline tags: "space", "digit" or "other". */
function neighbour(tokens, i, dir) {
  for (let j = i + dir; j >= 0 && j < tokens.length; j += dir) {
    const t = tokens[j];
    if (t.type === "tag") continue;
    if (t.type === "brk") return "space";
    if (t.type === "ent") return SPACE_ENTITY.test(t.raw) ? "space" : "other";
    if (t.type !== "text") return "other";
    const ch = dir < 0 ? t.raw[t.raw.length - 1] : t.raw[0];
    return /\s/.test(ch) ? "space" : /[0-9]/.test(ch) ? "digit" : "other";
  }
  return "space";
}

/** May the tokens strictly between `from` and `to` be wrapped: something to read, and tags that stay valid? */
function wrappable(tokens, from, to) {
  let readable = false;
  let tags = "";
  for (let j = from + 1; j < to; j++) {
    const t = tokens[j];
    if (t.type === "tag") tags += t.raw;
    else if (t.type === "atom" || (t.type === "text" && /[\p{L}\p{N}]/u.test(t.raw))) readable = true;
  }
  return readable && isBalanced(tags);
}

/** Convert `*…*`, `**…**` and `***…***` in a string of chat HTML to <em> / <strong>; `\*` becomes `*`. */
export function markupToEmphasis(html) {
  if (typeof html !== "string" || !html.includes("*")) return html;
  const tokens = tokenize(html);
  const openers = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "brk") openers.length = 0;
    if (t.type !== "run" || t.raw.length > 3) continue;
    const len = t.raw.length;
    const prev = neighbour(tokens, i, -1);
    const next = neighbour(tokens, i, 1);
    if (prev === "digit" && next === "digit") continue; // 2*3
    if (prev !== "space") {
      // The nearest opening run of the same length is the partner, or nothing is.
      let s = openers.length - 1;
      while (s >= 0 && openers[s].len !== len) s--;
      if (s >= 0) {
        if (wrappable(tokens, openers[s].index, i)) {
          tokens[openers[s].index].out = OPEN[len];
          t.out = CLOSE[len];
        }
        openers.length = s; // the pair is used up either way (`*^^*`); runs in between stay as written
        continue;
      }
    }
    if (next !== "space") openers.push({ index: i, len });
  }
  return tokens.map((t) => t.out ?? (t.type === "esc" ? "*" : t.raw)).join("");
}

function toMarkup(html, tags, escape) {
  return tokenize(html)
    .map((t) => {
      if (tags && t.type === "tag" && TAG_MARKUP[t.raw]) return TAG_MARKUP[t.raw];
      if (escape && t.type === "run") return t.raw.replace(/\*/g, "\\*");
      if (escape && t.type === "esc") return `\\${t.raw}`;
      return t.raw;
    })
    .join("");
}

/**
 * Convert <em> / <strong> back to `*` markup (for the edit dialog), escaping literal asterisks when they would
 * otherwise read as markup. Only a form that `markupToEmphasis` turns back into exactly the same HTML is used;
 * when there is none, the HTML is returned unchanged.
 */
export function emphasisToMarkup(html) {
  if (typeof html !== "string" || !/\*|<em>|<strong>/.test(html)) return html;
  for (const [tags, escape] of [[true, false], [true, true], [false, false], [false, true]]) {
    const markup = toMarkup(html, tags, escape);
    if (markupToEmphasis(markup) === html) return markup;
  }
  return html;
}

/** Tags only a system or module card would use. This module's own image wrappers (`ci-…`) are fine. */
const CARD_TAG = /<(?:div|section|article|header|footer|aside|nav|table|form|button|input|select|textarea|fieldset|details|figure)\b[^>]*>/gi;
const OWN_WRAPPER = /^<div class="ci-[\w-]+"\s*>$/i;

/** Is this the HTML of an ordinary written message (not a system card)? Only those get emphasis markup. */
export function isPlainMessageHtml(html) {
  if (typeof html !== "string") return false;
  for (const m of html.matchAll(CARD_TAG)) if (!OWN_WRAPPER.test(m[0])) return false;
  return true;
}

/**
 * preCreateChatMessage: store emphasis as HTML so every client, archive and export renders it.
 * Rolls, notes and cards are left alone. Edits go through the edit dialog, which converts by itself;
 * there is no preUpdate hook because converting twice would undo `\*`.
 */
export function onPreCreateChatMessageEmphasis(message) {
  if (message?.flags?.["gatos-chat-tools"]?.note) return; // notes stay plain text
  if (message?.rolls?.length) return;
  const content = message?._source?.content;
  if (typeof content !== "string" || !content.includes("*") || !isPlainMessageHtml(content)) return;
  const converted = markupToEmphasis(content);
  if (converted !== content) message.updateSource({ content: converted });
}
