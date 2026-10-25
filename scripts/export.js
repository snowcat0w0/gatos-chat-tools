import { MODULE_ID, L, mod, fmtDateTime, fmtDate } from "./constants.js";
import { download as saveFile, esc, safeFilename, stamp } from "./lib.js";
import { setting } from "./settings.js";
import { groupSerialized } from "./grouping.js";
import { pastelOf, stripChitchatMarkup } from "./chitchat.js";
import { buildZip } from "./zip.js";

const BLOCK_TAGS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "TABLE", "SECTION", "HEADER", "FOOTER", "BLOCKQUOTE", "PRE", "HR"]);

/** Convert a fragment of chat HTML to readable plain text. */
export function htmlToText(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root");
  root.querySelectorAll(".dice-tooltip, script, style, template").forEach((e) => e.remove());
  root.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  root.querySelectorAll("td, th").forEach((c) => c.append("\t"));
  root.querySelectorAll("*").forEach((el) => {
    if (BLOCK_TAGS.has(el.tagName)) {
      el.prepend("\n");
      el.append("\n");
    }
  });
  return root.textContent
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Individual dice of every roll in a message's rendered HTML, e.g. ["1d20 + 5 = 15 (1d20: 11)"].
 * Read from the dice tooltip markup, so it works for live and archived messages alike.
 */
export function diceDetails(html) {
  if (!html || !/dice-roll/.test(html)) return [];
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const out = [];
  for (const roll of doc.querySelectorAll(".dice-roll")) {
    const formula = roll.querySelector(".dice-formula")?.textContent.trim() ?? "";
    const total = roll.querySelector(".dice-total")?.textContent.trim() ?? "";
    const parts = [...roll.querySelectorAll(".tooltip-part, .dice")].map((part) => {
      const f = part.querySelector(".part-formula")?.textContent.trim() ?? "";
      const dice = [...part.querySelectorAll("li.roll")].map((li) => li.textContent.trim()).filter(Boolean);
      return f && dice.length ? `${f}: ${dice.join(", ")}` : "";
    });
    const detail = [...new Set(parts.filter(Boolean))].join(" / ");
    if (formula || total) out.push(`${formula}${total ? ` = ${total}` : ""}${detail ? ` (${detail})` : ""}`);
  }
  return out;
}

/** Describe the whisper/blind status of a serialized message for display. */
export function secretLabel(m) {
  if (m.blind) return L("Viewer.Blind");
  if (m.whisper?.length) return `${L("Viewer.Whisper")}: ${(m.whisperNames ?? []).join(", ")}`;
  return "";
}

function periodLabel(messages) {
  if (!messages.length) return "-";
  return `${fmtDateTime(messages[0].timestamp)} ~ ${fmtDateTime(messages[messages.length - 1].timestamp)}`;
}

/* -------------------------------------------- */
/*  Plain text                                  */
/* -------------------------------------------- */

export function toText(messages, { title, source, diceDetails: withDice = false } = {}) {
  const lines = [];
  lines.push(`=== ${title ?? L("Export.Title", { world: game.world.title })} ===`);
  if (source) lines.push(`${L("Export.Source")}: ${source}`);
  lines.push(`${L("Export.Period")}: ${periodLabel(messages)}`);
  lines.push(`${L("Export.Messages")}: ${L("Export.Count", { count: messages.length })}`);
  lines.push(`${L("Export.ExportedAt")}: ${fmtDateTime(Date.now())}`);
  lines.push("");

  let lastDay = "";
  for (const m of messages) {
    const day = fmtDate(m.timestamp);
    if (day !== lastDay) {
      lines.push(`----- ${day} -----`);
      lastDay = day;
    }
    const who = m.chitchat ? m.user || m.alias || "?" : m.user && m.user !== m.alias ? `${m.alias} (${m.user})` : m.alias || m.user || "?";
    const secret = secretLabel(m);
    const tag = m.chitchat ? ` (${L("Chitchat.Label")})` : "";
    lines.push(`[${fmtDateTime(m.timestamp).slice(11)}] ${who}${tag}${secret ? ` [${secret}]` : ""}`);
    const flavor = htmlToText(m.flavor);
    if (flavor) lines.push(`  * ${flavor.replace(/\n/g, "\n  ")}`);
    const body = htmlToText(m.chitchat ? stripChitchatMarkup(m.html || m.content) : m.html || m.content);
    if (body) lines.push(`  ${body.replace(/\n/g, "\n  ")}`);
    if (withDice) for (const d of diceDetails(m.html || m.content)) lines.push(`  [${L("Export.Dice")}] ${d}`);
    lines.push("");
  }
  return lines.join("\n");
}

/* -------------------------------------------- */
/*  Markdown                                    */
/* -------------------------------------------- */

const mdEscape = (s) => String(s ?? "").replace(/([\\`*_\[\]#>|])/g, "\\$1");

export function toMarkdown(messages, { title, source, diceDetails: withDice = false } = {}) {
  const lines = [];
  lines.push(`# ${mdEscape(title ?? L("Export.Title", { world: game.world.title }))}`);
  lines.push("");
  const meta = [source ? `${L("Export.Source")}: ${mdEscape(source)}` : "", `${L("Export.Period")}: ${periodLabel(messages)}`, `${L("Export.Messages")}: ${L("Export.Count", { count: messages.length })}`].filter(Boolean);
  lines.push(`> ${meta.join(" · ")}`);
  lines.push("");
  let lastDay = "";
  for (const m of messages) {
    const day = fmtDate(m.timestamp);
    if (day !== lastDay) {
      lines.push(`## ${day}`, "");
      lastDay = day;
    }
    const time = fmtDateTime(m.timestamp).slice(11, 16);
    const body = htmlToText(m.chitchat ? stripChitchatMarkup(m.html || m.content) : m.html || m.content);
    if (m.sessionMarker) {
      lines.push(`---`, ``, `**${mdEscape(body)}** · ${time}`, ``, `---`, "");
      continue;
    }
    if (m.chitchat) {
      lines.push(`- *${mdEscape(m.user || m.alias)}*: ${mdEscape(body).replace(/\n/g, " ")} <sub>${time}</sub>`, "");
      continue;
    }
    const secret = secretLabel(m);
    const user = m.user && m.user !== m.alias ? ` (${mdEscape(m.user)})` : "";
    lines.push(`**${mdEscape(m.alias || m.user)}**${user} · ${time}${secret ? ` · _${mdEscape(secret)}_` : ""}${m.highlight ? " ★" : ""}  `);
    const flavor = htmlToText(m.flavor);
    if (flavor) lines.push(`*${mdEscape(flavor).replace(/\n/g, " ")}*  `);
    if (body) lines.push(mdEscape(body).replace(/\n/g, "  \n"));
    if (withDice) for (const d of diceDetails(m.html || m.content)) lines.push(`> 🎲 ${mdEscape(d)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/* -------------------------------------------- */
/*  HTML                                        */
/* -------------------------------------------- */

const ORIGIN = () => window.location.origin;
const routePrefix = () => foundry.utils.getRoute("").replace(/\/$/, "");

/** Make relative src/href attributes absolute so exported HTML still shows images when opened from disk. */
function absolutize(html) {
  if (!html) return "";
  const prefix = routePrefix();
  return html.replace(/\b(src|href)=(["'])(?!https?:|data:|blob:|#|\/\/|mailto:)\/?([^"']*)\2/gi, (_, attr, q, path) => {
    return `${attr}=${q}${ORIGIN()}${prefix}/${path}${q}`;
  });
}

/** Absolute URL for a data path (worlds/…, modules/…) or an already absolute URL. */
export function absoluteUrl(path) {
  if (!path) return path;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  if (path.startsWith("//")) return `${window.location.protocol}${path}`;
  return `${ORIGIN()}${routePrefix()}/${path.replace(/^\//, "")}`;
}

export const EXPORT_CSS = `
:root { color-scheme: dark; }
body { margin: 0; padding: 24px; background: #1b1d24; color: #e6e6e6; font: 14px/1.5 "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; }
.wrap { max-width: 900px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
.meta { color: #9aa0ad; font-size: 12px; margin-bottom: 20px; }
.day { margin: 24px 0 8px; font-size: 13px; color: #c9a84c; border-bottom: 1px solid #3a3d47; padding-bottom: 2px; }
.msg { border: 1px solid #3a3d47; border-radius: 6px; padding: 8px 12px; margin: 0 0 8px; background: #23262f; }
.msg header .portrait { flex: 0 0 auto; width: 32px; height: 32px; object-fit: cover; object-position: top; border-radius: 4px; border: 1px solid #3a3d47; background: #11131a; }
.msg .body { min-width: 0; }
.msg.whisper { background: #2b2b3a; border-color: #5c5a8a; }
.msg.blind { background: #332b2b; border-color: #8a5a5a; }
.msg header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: #9aa0ad; margin-bottom: 4px; }
.msg header .alias { font-weight: 700; font-size: 14px; color: #fff; }
.msg header .secret { color: #c9a84c; }
.msg header time { margin-left: auto; }
.msg.g-top, .msg.g-middle { margin-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.msg.cont { border-top: none; border-top-left-radius: 0; border-top-right-radius: 0; padding-top: 2px; }
.msg.cont header .alias, .msg.cont header .user, .msg.cont header .secret { display: none; }
.msg.cont header { margin-bottom: 0; opacity: 0.6; font-size: 11px; }
.msg.chitchat { background: var(--cc-bg, #e8e8e8); border-color: var(--cc, #888); color: #222; padding: 4px 10px; margin-left: 28px; }
.msg.chitchat .body { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.msg.chitchat .cc-name { font-weight: 700; color: #333; flex: 0 0 auto; }
.msg.chitchat .cc-text { flex: 1 1 auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.chitchat header { margin: 0; flex: 0 0 auto; color: #555; }
.msg.chitchat.cont { padding-top: 2px; }
.flavor { font-style: italic; color: #cbd0dc; margin-bottom: 4px; }
.content img { max-width: 100%; height: auto; }
.content table { border-collapse: collapse; }
.content td, .content th { border: 1px solid #3a3d47; padding: 2px 6px; }
.content a { color: #8ab4f8; }
.dice-roll .dice-formula, .dice-roll .dice-total { display: inline-block; border: 1px solid #555; border-radius: 3px; padding: 0 6px; margin: 2px 4px 2px 0; }
.dice-roll .dice-total { font-weight: 700; }
ruby { ruby-align: center; } rt { font-size: 0.6em; color: #9aa0ad; } rp { display: none; }
.dice-tooltip { display: none; font-size: 12px; color: #9aa0ad; }
.dice-roll:hover .dice-tooltip { display: block; }
button, input[type=checkbox] { display: none; }
.dice-open .dice-tooltip { display: block; }
.msg.uc { border-left: 4px solid var(--uc, #888); }
.msg.uc header .alias::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--uc, #888); margin-right: 6px; vertical-align: middle; }
.msg.highlight { box-shadow: inset 3px 0 0 #e0b84c; background: #2e2a1f; }
.msg.marker { justify-content: center; background: transparent; border-style: dashed; color: #c9a84c; font-weight: 700; }
.gct-session-marker { text-align: center; }
`;

/**
 * Render a full standalone HTML document (image URLs absolute).
 * @param {object[]} messages           Serialized messages, oldest first.
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {string} [opts.source]
 * @param {boolean} [opts.portraits=true]
 * @param {string|null} [opts.cssHref]   When set, link this stylesheet instead of inlining the CSS.
 */
export function renderDocument(messages, { title, source, portraits = true, cssHref = null, userColors = false, diceDetails: openDice = false } = {}) {
  title ??= L("Export.Title", { world: game.world.title });
  const groups = groupSerialized(messages);
  const parts = [];
  parts.push(`<!DOCTYPE html><html lang="${esc(game.i18n.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`);
  parts.push(cssHref ? `<link rel="stylesheet" href="${esc(cssHref)}">` : `<style>${EXPORT_CSS}</style>`);
  parts.push(`</head><body${openDice ? ' class="dice-open"' : ""}><div class="wrap">`);
  parts.push(`<h1>${esc(title)}</h1>`);
  parts.push(`<div class="meta">${source ? `${esc(L("Export.Source"))}: ${esc(source)} · ` : ""}${esc(L("Export.Period"))}: ${esc(periodLabel(messages))} · ${esc(L("Export.Messages"))}: ${esc(L("Export.Count", { count: messages.length }))} · ${esc(L("Export.ExportedAt"))}: ${esc(fmtDateTime(Date.now()))}</div>`);

  const brightness = setting("chitchatBrightness");
  let lastDay = "";
  messages.forEach((m, i) => {
    const day = fmtDate(m.timestamp);
    if (day !== lastDay) {
      parts.push(`<div class="day">${esc(day)}</div>`);
      lastDay = day;
    }
    const g = groups[i];
    const cont = g === "middle" || g === "end";
    const uc = userColors && m.color && !m.chitchat && !m.sessionMarker;
    const cls = ["msg", m.blind ? "blind" : "", m.whisper?.length ? "whisper" : "", m.chitchat ? "chitchat" : "", m.highlight ? "highlight" : "", m.sessionMarker ? "marker" : "", uc ? "uc" : "", g ? `g-${g}` : "", cont ? "cont" : ""].filter(Boolean).join(" ");
    const time = fmtDateTime(m.timestamp).slice(11);
    const idAttr = (m.id ? ` data-message-id="${esc(m.id)}"` : "") + (uc ? ` style="--uc:${esc(m.color)}"` : "");
    if (m.sessionMarker) {
      parts.push(`<article class="${cls}"${idAttr}><div class="body content">${absolutize(m.html || m.content)}</div></article>`);
      return;
    }
    if (m.chitchat) {
      const color = m.color ?? "#888888";
      parts.push(`<article class="${cls}"${idAttr} style="--cc:${esc(color)};--cc-bg:${esc(pastelOf(color, brightness))}">`);
      parts.push(`<div class="body"><span class="cc-name">${esc(m.user || m.alias)}</span><span class="cc-text content">${absolutize(stripChitchatMarkup(m.html || m.content))}</span><header><time>${esc(time)}</time></header></div>`);
      parts.push(`</article>`);
      return;
    }
    const secret = secretLabel(m);
    parts.push(`<article class="${cls}"${idAttr}>`);
    let portrait = "";
    if (portraits && m.img && !cont) {
      const label = m.imgLabel ? ` title="${esc(m.imgLabel)}"` : "";
      portrait = absolutize(`<img class="portrait" src="${esc(m.img)}" alt=""${label}>`);
    }
    parts.push(`<div class="body">`);
    parts.push(`<header>${portrait}<span class="alias">${esc(m.alias || m.user)}</span>${m.user && m.user !== m.alias ? `<span class="user">${esc(m.user)}</span>` : ""}${secret ? `<span class="secret">${esc(secret)}</span>` : ""}<time>${esc(time)}</time></header>`);
    if (m.flavor) parts.push(`<div class="flavor">${absolutize(m.flavor)}</div>`);
    parts.push(`<div class="content">${absolutize(m.html || m.content)}</div>`);
    parts.push(`</div></article>`);
  });
  parts.push(`</div></body></html>`);
  return parts.join("\n");
}

/* -------------------------------------------- */
/*  Image handling                              */
/* -------------------------------------------- */

const MAX_INLINE_BYTES = 4 * 1024 * 1024;

async function fetchBlob(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch (err) {
    mod.warn(`image fetch failed: ${url}`, err);
    return null;
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function fileNameOf(url) {
  let name;
  try {
    name = decodeURIComponent(new URL(url, window.location.href).pathname.split("/").pop() || "");
  } catch {
    name = decodeURIComponent(url.split("/").pop() || "");
  }
  name = name.replace(/[\\/:*?"<>|]+/g, "_");
  return name || "image";
}

/** Replace every image in the document with a data URI (self-contained single file). */
export async function inlineImages(html, { onProgress } = {}) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgs = [...doc.querySelectorAll("img[src]")].filter((img) => !/^data:/.test(img.getAttribute("src")));
  const cache = new Map();
  let done = 0;
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!cache.has(src)) {
      const blob = await fetchBlob(src);
      cache.set(src, blob && blob.size <= MAX_INLINE_BYTES ? await blobToDataURL(blob) : null);
    }
    const data = cache.get(src);
    if (data) img.setAttribute("src", data);
    onProgress?.(++done / imgs.length);
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/**
 * Maps source image URLs to unique bundle paths (`<folder>/<file name>`), remembering every file to fetch.
 * `files` maps bundle path → source: a URL string (fetched), a Blob, or `{ text }` (written as is).
 */
export function createRelinker(files = new Map()) {
  const byUrl = new Map();
  return {
    files,
    /** Bundle path for an image URL (data paths are made absolute first). The same URL+folder always gives the same path. */
    relink(src, folder = "images") {
      if (!src || /^data:/.test(src)) return src;
      const url = absoluteUrl(src);
      const key = `${folder}|${url}`;
      let path = byUrl.get(key);
      if (path) return path;
      let name = fileNameOf(url);
      if (files.has(`${folder}/${name}`)) {
        const dot = name.lastIndexOf(".");
        name = dot > 0 ? `${name.slice(0, dot)}-${shortHash(url)}${name.slice(dot)}` : `${name}-${shortHash(url)}`;
      }
      path = `${folder}/${name}`;
      byUrl.set(key, path);
      files.set(path, url);
      return path;
    },
  };
}

/** Rewrite every <img> of a parsed document to bundle paths (portraits/… for card portraits, images/… otherwise). */
function relinkDocument(doc, relinker) {
  for (const img of doc.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src");
    if (/^data:/.test(src)) continue;
    img.setAttribute("src", relinker.relink(src, img.classList.contains("portrait") ? "portraits" : "images"));
  }
}

/**
 * Rewrite image URLs to relative bundle paths (images/… and portraits/…).
 * @returns {{html: string, files: Map<string, string>}} files maps bundle path → source URL.
 */
export function relinkImages(html, relinker = createRelinker()) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  relinkDocument(doc, relinker);
  return { html: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, files: relinker.files };
}

async function fileData(source) {
  if (source instanceof Blob) return source;
  if (source && typeof source === "object" && "text" in source) return String(source.text);
  return fetchBlob(source);
}

async function fetchFiles(files, onProgress) {
  const out = [];
  const entries = [...files.entries()];
  for (let i = 0; i < entries.length; i += 6) {
    const chunk = entries.slice(i, i + 6);
    const blobs = await Promise.all(chunk.map(([path, source]) => fileData(source).then((blob) => ({ path, blob }))));
    for (const b of blobs) if (b.blob != null) out.push(b);
    onProgress?.(Math.min(1, (i + 6) / entries.length));
  }
  return out;
}

/* -------------------------------------------- */
/*  Extension pipeline                          */
/* -------------------------------------------- */

/**
 * Run the `gctExportRender` hook over a rendered document so other modules can rewrite it.
 * @param {string} html
 * @param {object} ctx  { mode, meta, messages, relink? }
 */
function applyExportRender(html, ctx) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  Hooks.callAll("gctExportRender", doc, ctx);
  return doc;
}

const serializeDoc = (doc) => `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;

/** Render a document for the single-file / window modes (no bundle). */
function renderForMode(messages, meta, mode) {
  const ctx = { mode, meta, messages, relink: (url) => absoluteUrl(url) };
  return serializeDoc(applyExportRender(renderDocument(messages, meta), ctx));
}

/** The <name>.log.json written next to a bundle: serialized messages with images rewritten to bundle paths. */
function buildLog(messages, meta, relinker) {
  const out = foundry.utils.deepClone(messages).map((m) => {
    if (m.img) m.img = relinker.relink(m.img, "portraits");
    for (const key of ["html", "flavor"]) {
      if (!m[key] || !/<img/i.test(m[key])) continue;
      const doc = new DOMParser().parseFromString(`<div id="root">${absolutize(m[key])}</div>`, "text/html");
      relinkDocument(doc, relinker);
      m[key] = doc.getElementById("root").innerHTML;
    }
    return m;
  });
  return {
    module: MODULE_ID,
    version: 2,
    kind: "export-log",
    title: meta?.title ?? L("Export.Title", { world: game.world.title }),
    source: meta?.source ?? null,
    world: game.world.id,
    worldTitle: game.world.title,
    system: game.system.id,
    exportedAt: Date.now(),
    from: out[0]?.timestamp ?? null,
    to: out.at(-1)?.timestamp ?? null,
    count: out.length,
    messages: out,
  };
}

/**
 * Build a multi-file export bundle (zip / folder modes).
 * Hooks: `gctExportRender(doc, ctx)` on the parsed HTML, `gctExportLog(log, ctx)` on the log JSON,
 * `gctExportBundle(bundle, ctx)` last. `ctx.relink(url, folder)` adds a file to the bundle and returns its path.
 * @returns {Promise<{name: string, html: string, css: string, files: Map<string, string|Blob|{text: string}>}>}
 */
export async function buildBundle(messages, meta, mode) {
  const relinker = createRelinker();
  const ctx = { mode, meta, messages, relink: (url, folder) => relinker.relink(url, folder) };
  const doc = applyExportRender(renderDocument(messages, { ...meta, cssHref: "chat-styles.css" }), ctx);
  relinkDocument(doc, relinker);
  const name = archiveFileName("html", { withTime: true });
  // The log is named after its page, so several exports can share one folder without overwriting each other.
  const bundle = { name, logName: name.replace(/\.html$/i, ".log.json"), html: serializeDoc(doc), css: EXPORT_CSS, files: relinker.files };
  ctx.bundle = bundle;
  const log = buildLog(messages, meta, relinker);
  Hooks.callAll("gctExportLog", log, ctx);
  bundle.files.set(bundle.logName, { text: JSON.stringify(log) });
  Hooks.callAll("gctExportBundle", bundle, ctx);
  return bundle;
}

/* -------------------------------------------- */
/*  File names & download                       */
/* -------------------------------------------- */

/** gatos-lib safeFilename / stamp (both ported from here). */
export function archiveFileName(ext, { withTime = false } = {}) {
  return `chat-log-${stamp(withTime)}-${safeFilename(game.world.title)}.${ext}`;
}

/** gatos-lib download: strings go through foundry.utils.saveDataToFile as before, Blobs through an object URL. */
function download(data, type, filename) {
  saveFile(data, { type, name: filename });
}

/* -------------------------------------------- */
/*  Export modes                                */
/* -------------------------------------------- */

export function exportText(messages, meta) {
  download(toText(messages, meta), "text/plain;charset=utf-8", archiveFileName("txt"));
}

export function exportMarkdown(messages, meta) {
  download(toMarkdown(messages, meta), "text/markdown;charset=utf-8", archiveFileName("md"));
}

/** HTML for one journal page (Foundry-internal image paths stay relative). */
function journalHtml(messages, { portraits = true, diceDetails: withDice = false } = {}) {
  const parts = [];
  for (const m of messages) {
    const time = fmtDateTime(m.timestamp).slice(11, 16);
    const content = (m.chitchat ? stripChitchatMarkup(m.html || m.content) : m.html || m.content) || "";
    if (m.sessionMarker) {
      parts.push(`<hr><h3 style="text-align:center">${esc(htmlToText(content))} <span style="font-size:0.7em;opacity:0.6">${esc(time)}</span></h3><hr>`);
      continue;
    }
    if (m.chitchat) {
      parts.push(`<p style="opacity:0.75;font-size:0.9em"><strong>${esc(m.user || m.alias)}</strong>: ${esc(htmlToText(content))} <span style="opacity:0.6">${esc(time)}</span></p>`);
      continue;
    }
    const secret = secretLabel(m);
    const img = portraits && m.img ? `<img src="${esc(m.img)}" width="32" height="32" style="vertical-align:middle;border:none;object-fit:cover;margin-right:6px">` : "";
    parts.push(`<p>${img}<strong>${esc(m.alias || m.user)}</strong>${m.user && m.user !== m.alias ? ` <span style="opacity:0.6">(${esc(m.user)})</span>` : ""} <span style="opacity:0.6">${esc(time)}</span>${secret ? ` <em>[${esc(secret)}]</em>` : ""}${m.highlight ? " ★" : ""}</p>`);
    if (m.flavor) parts.push(`<p><em>${m.flavor}</em></p>`);
    let body = content;
    if (!withDice && /dice-tooltip/.test(body)) {
      const doc = new DOMParser().parseFromString(`<div id="root">${body}</div>`, "text/html");
      doc.querySelectorAll(".dice-tooltip").forEach((e) => e.remove());
      body = doc.getElementById("root").innerHTML;
    }
    parts.push(`<blockquote>${body}</blockquote>`);
  }
  return parts.join("\n");
}

/**
 * Create a JournalEntry with one text page per day.
 * @param {object[]} messages
 * @param {object} meta
 * @param {{publicView?: boolean}} [opts]  publicView: players get Observer permission.
 */
export async function exportJournal(messages, meta, { publicView = false } = {}) {
  if (!game.user.can("JOURNAL_CREATE")) throw new Error(L("ExportDialog.JournalNoPermission"));
  const byDay = new Map();
  for (const m of messages) {
    const day = fmtDate(m.timestamp);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(m);
  }
  const pages = [...byDay].map(([day, list], i) => ({
    name: day,
    type: "text",
    sort: (i + 1) * 100000,
    text: { content: journalHtml(list, meta), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
  }));
  const ownership = { default: publicView ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };
  const entry = await JournalEntry.create({ name: meta?.title ?? L("Export.Title", { world: game.world.title }), pages, ownership });
  entry?.sheet?.render(true);
  ui.notifications.info(L("ExportDialog.JournalDone", { name: entry?.name ?? "" }));
  return entry;
}

/** One self-contained HTML file with CSS and images embedded. */
export async function exportSingleHtml(messages, meta) {
  const progress = ui.notifications.info(L("ExportDialog.Working"), { progress: true });
  const html = await inlineImages(renderForMode(messages, meta, "single"), { onProgress: (p) => progress.update({ pct: p * 0.95 }) });
  download(html, "text/html;charset=utf-8", archiveFileName("html"));
  progress.update({ pct: 1, message: L("ExportDialog.Done") });
}

/** Bundle: html + chat-styles.css + <name>.log.json + images/ + portraits/ (+ files added by hooks) in a zip. */
export async function exportZip(messages, meta) {
  const progress = ui.notifications.info(L("ExportDialog.Working"), { progress: true });
  const bundle = await buildBundle(messages, meta, "zip");
  const blobs = await fetchFiles(bundle.files, (p) => progress.update({ pct: p * 0.8 }));
  const entries = [
    { name: bundle.name, data: bundle.html },
    { name: "chat-styles.css", data: bundle.css },
    ...blobs.map((b) => ({ name: b.path, data: b.blob })),
  ];
  const zip = await buildZip(entries);
  download(zip, "application/zip", archiveFileName("zip", { withTime: true }));
  progress.update({ pct: 1, message: L("ExportDialog.Done") });
}

/** Open the log in a new browser window (no downloads). */
export function openInWindow(messages, meta) {
  const win = window.open("", "_blank");
  if (!win) {
    ui.notifications.error(L("ExportDialog.PopupBlocked"));
    return;
  }
  win.document.open();
  win.document.write(renderForMode(messages, meta, "window"));
  win.document.close();
}

/* -------------------------------------------- */
/*  Directory mode (File System Access API)     */
/* -------------------------------------------- */

const DB_NAME = "gatos-chat-tools";
const STORE = "handles";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    if (value === null) tx.objectStore(STORE).delete(key);
    else tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const isDirectoryPickerSupported = () => typeof window.showDirectoryPicker === "function";

const dirKey = () => `dir:${game.world.id}`;

/** Forget the remembered export folder for this world. */
export async function clearExportDirectory() {
  await idbSet(dirKey(), null).catch(() => {});
}

async function getExportDirectory() {
  const stored = await idbGet(dirKey()).catch(() => null);
  if (stored) {
    const opts = { mode: "readwrite" };
    if ((await stored.queryPermission?.(opts)) === "granted" || (await stored.requestPermission?.(opts)) === "granted") return stored;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idbSet(dirKey(), handle).catch(() => {});
    return handle;
  } catch (err) {
    if (err?.name === "AbortError") return null;
    throw err;
  }
}

async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

/**
 * Write html + chat-styles.css + images/ + portraits/ directly into a folder chosen once per world.
 * Must be called from a user gesture (the picker is opened before any heavy work).
 */
export async function exportToDirectory(messages, meta) {
  if (!isDirectoryPickerSupported()) {
    ui.notifications.warn(L("ExportDialog.DirUnsupported"));
    return false;
  }
  const dir = await getExportDirectory();
  if (!dir) return false;
  const progress = ui.notifications.info(L("ExportDialog.Working"), { progress: true });
  const bundle = await buildBundle(messages, meta, "dir");
  await writeFile(dir, "chat-styles.css", bundle.css);
  await writeFile(dir, bundle.name, bundle.html);
  const blobs = await fetchFiles(bundle.files, (p) => progress.update({ pct: 0.1 + p * 0.8 }));
  const subdirs = new Map([["", dir]]);
  const dirFor = async (folder) => {
    if (subdirs.has(folder)) return subdirs.get(folder);
    const slash = folder.lastIndexOf("/");
    const parent = await dirFor(slash < 0 ? "" : folder.slice(0, slash));
    const handle = await parent.getDirectoryHandle(folder.slice(slash + 1), { create: true });
    subdirs.set(folder, handle);
    return handle;
  };
  for (const { path, blob } of blobs) {
    const slash = path.lastIndexOf("/");
    await writeFile(await dirFor(slash < 0 ? "" : path.slice(0, slash)), path.slice(slash + 1), blob);
  }
  progress.update({ pct: 1, message: L("ExportDialog.DirDone", { name: dir.name }) });
  return true;
}

/* -------------------------------------------- */
/*  Convenience (kept for the API)              */
/* -------------------------------------------- */

export const toHTML = (messages, meta) => renderDocument(messages, meta);
export const downloadText = exportText;
export const downloadHTML = exportSingleHtml;
