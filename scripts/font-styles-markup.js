/**
 * Inline font styles: `{@name text}` ↔ `<span class="gct-fs" data-gct-fs="name" style="…">text</span>`.
 *
 * Pure functions with no Foundry globals, so they can be unit-tested in Node. The markup always starts with
 * `{@`, which keeps it apart from gatos-visual-novel's `{{keyword}}` / `{expression}` tags, from enricher labels
 * (`@UUID[…]{label}`) and from ruby markup (`[[base|reading]]`). The text may not contain `{` or `}` and may
 * not cross a paragraph; there is no nesting.
 */

/** Style names: letters (any script), digits, `_` and `-`, at most 32 characters. */
export const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

/** `{@name text}`: the separator after the name may be a space, a tab or a non-breaking space (as entity or char). */
const MARKUP = /\{@([\p{L}\p{N}_-]{1,32})(?:[ \t ]|&nbsp;)+([^{}]*)\}/gu;

/** A span produced by this module, in any attribute order, whose text holds no further span. */
const SPAN = /<span\b[^>]*?\bdata-gct-fs="([^"]+)"[^>]*>((?:(?!<span\b)[\s\S])*?)<\/span>/g;

/** Block-level tags a style must never cross (ProseMirror paragraphs, lists, …). */
const BLOCK = /<\/?(?:p|div|li|ul|ol|h[1-6]|blockquote|pre|table|thead|tbody|tr|td|th|section|article|header|footer|hr|details|summary)\b/i;

/** Void elements: no closing tag to balance. */
const VOID = new Set(["br", "img", "hr", "wbr", "input", "source", "track", "area", "col", "embed"]);

/** CSS generic family keywords, written without quotes. */
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);

export const isValidStyleName = (name) => typeof name === "string" && NAME_RE.test(name);

/**
 * A CSS `font-family` list from free text ("Nanum Pen Script", `"Gugi", cursive`, …). Names are stripped of
 * quotes and of every character outside letters, digits, space, `_`, `-` and `.`, then single-quoted (generic
 * keywords stay bare), so the result is safe inside a double-quoted style attribute. "" when nothing is left.
 */
export function fontFamilyCss(value) {
  return String(value ?? "")
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^["']+|["']+$/g, "")
        .replace(/[^\p{L}\p{N} _.-]/gu, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .slice(0, 6)
    .map((name) => (GENERIC.has(name.toLowerCase()) ? name.toLowerCase() : `'${name}'`))
    .join(", ");
}

/**
 * Normalize a stored style: `{ id, name, family, size, color, bold, italic }`. Returns null without a valid name.
 * size: px number 6–96 or null; color: `#rgb` / `#rrggbb` or null.
 */
export function sanitizeStyle(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim();
  if (!isValidStyleName(name)) return null;
  const size = Number(raw.size);
  const color = String(raw.color ?? "").trim();
  return {
    id: String(raw.id ?? "") || name,
    name,
    family: String(raw.family ?? "").trim().slice(0, 200),
    size: Number.isFinite(size) && size >= 6 && size <= 96 ? Math.round(size) : null,
    color: /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color.toLowerCase() : null,
    bold: !!raw.bold,
    italic: !!raw.italic,
  };
}

/** The inline CSS of a style (no quotes other than single quotes inside font-family). "" when it sets nothing. */
export function styleCss(style) {
  const s = sanitizeStyle(style);
  if (!s) return "";
  const parts = [];
  const family = fontFamilyCss(s.family);
  if (family) parts.push(`font-family:${family}`);
  if (s.size) parts.push(`font-size:${s.size}px`);
  if (s.color) parts.push(`color:${s.color}`);
  if (s.bold) parts.push("font-weight:700");
  if (s.italic) parts.push("font-style:italic");
  return parts.join(";");
}

/** The span for a style around already-escaped (or trusted) inner HTML. */
export function fontStyleSpan(style, innerHtml) {
  const css = styleCss(style);
  const name = sanitizeStyle(style)?.name ?? "";
  return `<span class="gct-fs" data-gct-fs="${name}"${css ? ` style="${css}"` : ""}>${innerHtml}</span>`;
}

/** Visible text of an HTML fragment, without parsing (entities count as one character). */
function visibleText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;| /g, " ")
    .replace(/&[a-z0-9#]+;/gi, "x");
}

/** Do the inline tags of a fragment open and close in order (so wrapping it in a span keeps the HTML valid)? */
export function isBalanced(html) {
  const stack = [];
  const re = /<(\/?)([a-z][a-z0-9-]*)\b[^>]*?(\/?)>/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) {
    const [, closing, tag, selfClosing] = m;
    const name = tag.toLowerCase();
    if (VOID.has(name) || selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

/** Turn a list (or `{list}` object, or Map) of styles into a name → style Map. */
function styleMap(styles) {
  if (styles instanceof Map) return styles;
  const list = Array.isArray(styles) ? styles : Array.isArray(styles?.list) ? styles.list : [];
  const map = new Map();
  for (const raw of list) {
    const s = sanitizeStyle(raw);
    if (s && !map.has(s.name)) map.set(s.name, s);
  }
  return map;
}

/**
 * Convert every `{@name text}` whose name is a known style into its span. Unknown names, empty texts,
 * texts crossing a block tag and texts with unbalanced tags are left exactly as written.
 * @param {string} html
 * @param {object[]|{list: object[]}|Map<string, object>} styles
 * @returns {{html: string, unknown: string[], converted: number}}
 */
export function markupToFontStyles(html, styles) {
  if (typeof html !== "string" || !html.includes("{@")) return { html, unknown: [], converted: 0 };
  const map = styleMap(styles);
  const unknown = new Set();
  let converted = 0;
  const out = html.replace(MARKUP, (whole, name, text) => {
    if (!visibleText(text).trim()) return whole;
    if (BLOCK.test(text) || !isBalanced(text)) return whole;
    const style = map.get(name);
    if (!style) {
      unknown.add(name);
      return whole;
    }
    converted++;
    return fontStyleSpan(style, text);
  });
  return { html: out, unknown: [...unknown], converted };
}

/** Convert spans produced by this module back to `{@name text}` markup (for the edit dialog). */
export function fontStylesToMarkup(html) {
  if (typeof html !== "string" || !html.includes("data-gct-fs")) return html;
  return html.replace(SPAN, (whole, name, text) => (isValidStyleName(name) ? `{@${name} ${text}}` : whole));
}

/** Remove the styling but keep the text (plain-text consumers). */
export function stripFontStyles(html) {
  if (typeof html !== "string" || !html.includes("data-gct-fs")) return html;
  return html.replace(SPAN, (whole, name, text) => text);
}
