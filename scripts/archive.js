import { MODULE_ID, L, mod, startOfDay, endOfDay } from "./constants.js";
import { cacheBust, download, safeFilename, settingStore, uploadJson } from "./lib.js";
import { setting } from "./settings.js";
import { portraitFor } from "./portrait.js";
import { isChitchat, chitchatName, stripChitchatMarkup } from "./chitchat.js";

/** Archive index setting as a store (gatos-lib settingStore: get() returns a deep clone). */
const indexStore = settingStore(mod, "archiveIndex");

/** Archive JSON format version. v2 adds `imgLabel` and the gctSerializeMessage / gctArchiveHeader extension hooks. */
export const ARCHIVE_VERSION = 2;

/** Directory (relative to the user data folder) where archive files are stored. */
export function archiveDir() {
  return `worlds/${game.world.id}/chat-archives`;
}

/** The archive index: a list of { id, name, path, createdAt, createdBy, from, to, count }. */
export function getIndex() {
  const list = indexStore.get()?.list ?? [];
  return list.sort((a, b) => a.createdAt - b.createdAt);
}

async function setIndex(list) {
  return indexStore.set({ list });
}

/* -------------------------------------------- */
/*  Collecting & serializing messages           */
/* -------------------------------------------- */

/** Resolve a range choice from the save dialog into { from, to } timestamps (null = open). */
export function resolveRange(range, fromTs = null, toTs = null) {
  const now = Date.now();
  switch (range) {
    case "sinceLast": {
      const last = setting("lastArchived");
      return { from: last ? last + 1 : null, to: null };
    }
    case "archived": {
      const last = setting("lastArchived");
      return { from: null, to: last || null };
    }
    case "today":
      return { from: startOfDay(now), to: null };
    case "7":
      return { from: startOfDay(now - 6 * 86400000), to: null };
    case "30":
      return { from: startOfDay(now - 29 * 86400000), to: null };
    case "custom":
      return { from: fromTs != null ? startOfDay(fromTs) : null, to: toTs != null ? endOfDay(toTs) : null };
    default:
      return { from: null, to: null };
  }
}

/** All chat messages (sorted oldest first) within the range. */
export function collectMessages({ from = null, to = null } = {}) {
  return game.messages.contents
    .filter((m) => (from == null || m.timestamp >= from) && (to == null || m.timestamp <= to))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Render the message's HTML and return the inner HTML of its content block (gatos-lib chat, ported from here). */
export { renderMessageContent } from "./lib.js";
import { renderMessageContent } from "./lib.js";

/** Serialize a ChatMessage document to a plain, archive-friendly object. */
export async function serializeMessage(message, { render = true } = {}) {
  const author = message.author ?? null;
  const portrait = portraitFor(message);
  const data = {
    id: message.id,
    timestamp: message.timestamp,
    user: author?.name ?? "",
    userId: author?.id ?? message._source?.author ?? null,
    color: author?.color?.css ?? null,
    alias: isChitchat(message) ? chitchatName(message) : message.alias,
    img: portrait.img,
    imgLabel: portrait.label ?? null,
    actor: message.speaker?.actor ?? null,
    token: message.speaker?.token ?? null,
    flavor: message.flavor ?? "",
    content: message.content ?? "",
    whisper: [...(message.whisper ?? [])],
    whisperNames: (message.whisper ?? []).map((id) => game.users.get(id)?.name ?? "?"),
    blind: !!message.blind,
    chitchat: isChitchat(message),
    highlight: !!message.flags?.[MODULE_ID]?.highlight,
    sessionMarker: message.flags?.[MODULE_ID]?.sessionMarker ?? null,
    isRoll: message.isRoll,
    rolls: message.isRoll ? message.rolls.map((r) => ({ formula: r.formula, total: r.total })) : [],
    type: message.type,
    style: message.style,
    html: "",
  };
  if (render) data.html = await renderMessageContent(message);
  if (data.chitchat) data.html = stripChitchatMarkup(data.html);
  // Let other modules add their own fields (e.g. gatos-visual-novel's `vn`).
  Hooks.callAll("gctSerializeMessage", message, data);
  return data;
}

/* -------------------------------------------- */
/*  Saving                                      */
/* -------------------------------------------- */


async function registerEntry(entry) {
  const list = getIndex();
  list.push(entry);
  await setIndex(list);
}

/**
 * Save messages in a range as a new archive file and register it in the index (GM only).
 * @param {object} opts
 * @param {string} opts.name
 * @param {number|null} [opts.from]
 * @param {number|null} [opts.to]
 * @param {boolean} [opts.deleteAfter=false]  Remove the archived messages from the chat log afterwards.
 * @returns {Promise<object|null>} The index entry, or null when nothing was saved.
 */
export async function saveArchive({ name, from = null, to = null, deleteAfter = false, extra = {}, quiet = false }) {
  if (!game.user.isGM) {
    ui.notifications.warn(L("Archive.GMOnly"));
    return null;
  }
  const messages = collectMessages({ from, to });
  if (!messages.length) {
    if (!quiet) ui.notifications.warn(L("Archive.NoMessages"));
    return null;
  }

  const progress = ui.notifications.info(L("Archive.Saving", { count: messages.length }), { progress: true });
  try {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
      out.push(await serializeMessage(messages[i]));
      if (i % 25 === 0) progress.update({ pct: (i / messages.length) * 0.9 });
    }

    const id = foundry.utils.randomID(12);
    const createdAt = Date.now();
    const first = out[0].timestamp;
    const last = out[out.length - 1].timestamp;
    name = name?.trim() || L("Archive.DefaultName", { world: game.world.title, date: new Date(createdAt).toLocaleDateString() });

    const archive = {
      module: MODULE_ID,
      version: ARCHIVE_VERSION,
      id,
      name,
      world: game.world.id,
      worldTitle: game.world.title,
      system: game.system.id,
      createdAt,
      createdBy: game.user.name,
      rangeFrom: from,
      rangeTo: to,
      from: first,
      to: last,
      count: out.length,
      ...extra,
      messages: out,
    };
    Hooks.callAll("gctArchiveHeader", archive);

    const path = await uploadJson(archiveDir(), `${id}.json`, archive);
    const entry = { id, name, path, createdAt, createdBy: game.user.name, from: first, to: last, count: out.length, ...extra };
    await registerEntry(entry);
    await game.settings.set(MODULE_ID, "lastArchived", Math.max(setting("lastArchived") ?? 0, last));
    cache.set(id, archive);
    progress.update({ pct: 1, message: L("Archive.Saved", { name, count: out.length }) });

    if (deleteAfter) await deleteMessagesChunked(messages.map((m) => m.id), L("Archive.Deleting"));

    Hooks.callAll("gctArchiveSaved", entry);
    return entry;
  } catch (err) {
    mod.error("archive save failed", err);
    progress.update({ pct: 1, message: L("Archive.SaveFailed", { error: err.message }), type: "error" });
    ui.notifications.error(L("Archive.SaveFailed", { error: err.message }));
    return null;
  }
}

/** Delete chat messages by id in chunks, with a progress notification. */
export async function deleteMessagesChunked(ids, label) {
  if (!ids.length) return 0;
  const progress = ui.notifications.info(label ?? L("DeleteRange.Deleting", { count: ids.length }), { progress: true });
  for (let i = 0; i < ids.length; i += 100) {
    await ChatMessage.deleteDocuments(ids.slice(i, i + 100));
    progress.update({ pct: Math.min(1, (i + 100) / ids.length) });
  }
  progress.update({ pct: 1 });
  return ids.length;
}

/**
 * Delete the current chat messages within a range (GM only).
 * @param {object} opts
 * @param {number|null} [opts.from]
 * @param {number|null} [opts.to]
 * @returns {Promise<number>} Number of messages deleted.
 */
export async function deleteMessagesInRange({ from = null, to = null } = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn(L("Archive.GMOnly"));
    return 0;
  }
  const ids = collectMessages({ from, to }).map((m) => m.id);
  if (!ids.length) {
    ui.notifications.warn(L("DeleteRange.NoMessages"));
    return 0;
  }
  const n = await deleteMessagesChunked(ids, L("DeleteRange.Deleting", { count: ids.length }));
  ui.notifications.info(L("DeleteRange.Done", { count: n }));
  Hooks.callAll("gctMessagesDeleted", { from, to, count: n });
  return n;
}

/* -------------------------------------------- */
/*  Loading                                     */
/* -------------------------------------------- */

const cache = new Map();

/** Fetch and parse an archive file. Cached per archive id. */
export async function loadArchive(entry) {
  if (cache.has(entry.id)) return cache.get(entry.id);
  const url = cacheBust(foundry.utils.getRoute(entry.path), entry.createdAt);
  const res = await fetch(url);
  if (!res.ok) throw new Error(L("Archive.LoadFailed", { path: entry.path }));
  const data = await res.json();
  if (data?.deleted) throw new Error(L("Files.Cleared", { name: entry.name }));
  cache.set(entry.id, data);
  return data;
}

/** Is an archived message visible to the current user? */
export function isArchivedMessageVisible(m) {
  if (game.user.isGM || !setting("hideSecret")) return true;
  if (m.blind) return false;
  if (m.whisper?.length) return m.userId === game.user.id || m.whisper.includes(game.user.id);
  return true;
}

/* -------------------------------------------- */
/*  Index management (GM)                       */
/* -------------------------------------------- */

export async function renameArchive(id, name) {
  const list = getIndex();
  const entry = list.find((e) => e.id === id);
  if (!entry || !name?.trim()) return;
  entry.name = name.trim();
  await setIndex(list);
}

/**
 * Remove an archive from the index. With `clearFile` the JSON file is overwritten with a small
 * tombstone (Foundry has no API to delete files, so this is the closest a module can get).
 */
export async function removeArchive(id, { clearFile = false } = {}) {
  const entry = getIndex().find((e) => e.id === id);
  if (clearFile && entry) await clearArchiveFile(entry);
  const list = getIndex().filter((e) => e.id !== id);
  cache.delete(id);
  await setIndex(list);
}

/* -------------------------------------------- */
/*  File management                             */
/* -------------------------------------------- */

/** Overwrite an archive's JSON file with a tombstone so its messages no longer take space. */
export async function clearArchiveFile(entry) {
  if (!game.user.isGM || !entry?.path) return;
  const slash = entry.path.lastIndexOf("/");
  const dir = entry.path.slice(0, slash);
  const filename = entry.path.slice(slash + 1);
  await uploadJson(dir, filename, { module: MODULE_ID, deleted: true, id: entry.id, name: entry.name, deletedAt: Date.now() });
  cache.delete(entry.id);
}

/** Download an archive's raw JSON (backup, or to import into another world). gatos-lib safeFilename / download. */
export async function downloadArchiveJson(entry) {
  const data = await loadArchive(entry);
  download(JSON.stringify(data), { type: "application/json", name: `${safeFilename(entry.name, "archive")}.json` });
}

function summarize(messages) {
  const sorted = messages.filter((m) => m && Number.isFinite(m.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  return { messages: sorted, from: sorted[0]?.timestamp ?? null, to: sorted.at(-1)?.timestamp ?? null, count: sorted.length };
}

/**
 * Import an archive JSON (from "JSON 받기", another world, or a bundle's log.json) as a new archive (GM).
 * @param {File} file
 */
export async function importArchiveFile(file) {
  if (!game.user.isGM) return ui.notifications.warn(L("Archive.GMOnly")), null;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(L("Files.ImportInvalid"));
  }
  if (!Array.isArray(data?.messages)) throw new Error(L("Files.ImportInvalid"));
  const { messages, from, to, count } = summarize(data.messages);
  if (!count) throw new Error(L("Files.ImportEmpty"));
  const id = foundry.utils.randomID(12);
  const createdAt = Date.now();
  const name = String(data.name ?? data.title ?? file.name.replace(/\.json$/i, "")).trim() || file.name;
  const imported = { file: file.name, world: data.world ?? null, worldTitle: data.worldTitle ?? null, at: createdAt };
  const archive = { ...data, module: MODULE_ID, version: data.version ?? ARCHIVE_VERSION, id, name, createdAt, createdBy: game.user.name, from, to, count, imported, messages };
  delete archive.kind;
  const path = await uploadJson(archiveDir(), `${id}.json`, archive);
  const entry = { id, name, path, createdAt, createdBy: game.user.name, from, to, count, imported: true };
  if (data.session) entry.session = data.session;
  await registerEntry(entry);
  cache.set(id, archive);
  Hooks.callAll("gctArchiveSaved", entry);
  return entry;
}

/**
 * Merge several archives into a new one (messages de-duplicated by id, sorted by time) (GM).
 * @param {string[]} ids
 * @param {{name?: string, removeOriginals?: boolean}} [opts]
 */
export async function mergeArchives(ids, { name = "", removeOriginals = false } = {}) {
  if (!game.user.isGM) return ui.notifications.warn(L("Archive.GMOnly")), null;
  const entries = getIndex().filter((e) => ids.includes(e.id));
  if (entries.length < 2) throw new Error(L("Files.MergeNeedTwo"));
  const byKey = new Map();
  for (const entry of entries) {
    const data = await loadArchive(entry);
    for (const m of data.messages ?? []) {
      const key = m.id ?? `${m.timestamp}|${m.userId ?? ""}|${String(m.content ?? "").slice(0, 80)}`;
      if (!byKey.has(key)) byKey.set(key, m);
    }
  }
  const { messages, from, to, count } = summarize([...byKey.values()]);
  const id = foundry.utils.randomID(12);
  const createdAt = Date.now();
  name = name.trim() || entries.map((e) => e.name).join(" + ");
  const merged = entries.map((e) => ({ id: e.id, name: e.name }));
  const archive = {
    module: MODULE_ID, version: ARCHIVE_VERSION, id, name,
    world: game.world.id, worldTitle: game.world.title, system: game.system.id,
    createdAt, createdBy: game.user.name, from, to, count, merged, messages,
  };
  Hooks.callAll("gctArchiveHeader", archive);
  const path = await uploadJson(archiveDir(), `${id}.json`, archive);
  const entry = { id, name, path, createdAt, createdBy: game.user.name, from, to, count, merged: merged.map((m) => m.id) };
  await registerEntry(entry);
  cache.set(id, archive);
  if (removeOriginals) {
    const keep = getIndex().filter((e) => !ids.includes(e.id));
    for (const e of entries) cache.delete(e.id);
    await setIndex(keep);
  }
  Hooks.callAll("gctArchiveSaved", entry);
  return entry;
}
