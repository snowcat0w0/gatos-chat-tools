import { MODULE_ID, L, mod, fmtDate, fmtDateTime } from "./constants.js";
import { esc, formDialog, isLeadGM, postMarker as postMarkerCard, readForm } from "./lib.js";
import { setting } from "./settings.js";
import { saveArchive, getIndex, collectMessages, deleteMessagesChunked } from "./archive.js";

/** A previous session's leftovers are archived on load only when the newest one is at least this old. */
const IDLE_MS = 3 * 60 * 60 * 1000;

/* -------------------------------------------- */
/*  Session state                               */
/* -------------------------------------------- */

/** The running session ({active, number, title, startedAt}) or null. */
export function getSession() {
  const s = setting("session");
  return s?.active ? s : null;
}

/** The next session number: one more than any number used so far. */
export function nextSessionNumber() {
  const used = getIndex().map((e) => e.session?.number ?? 0);
  return Math.max(0, setting("session")?.number ?? 0, ...used) + 1;
}

/** "제3회 「제목」" / "Session 3 — Title". */
export function sessionLabel(s) {
  if (!s) return "";
  return s.title ? L("Session.LabelTitled", { number: s.number, title: s.title }) : L("Session.Label", { number: s.number });
}

/** Post a start/end marker card (gatos-lib postMarker: OTHER style, module alias speaker). Returns the created message (or null when announcements are off). */
async function postMarker(type, s) {
  if (!setting("sessionAnnounce")) return null;
  const text = L(type === "start" ? "Session.StartedMsg" : "Session.EndedMsg", { label: sessionLabel(s) });
  return postMarkerCard(mod, {
    alias: L("Session.Speaker"),
    content: `<div class="gct-session-marker gct-session-${type}"><i class="fa-solid fa-flag"></i> ${esc(text)}</div>`,
    flags: { sessionMarker: { type, number: s.number, title: s.title } },
  });
}

/** Start a session (GM). */
export async function startSession({ number, title = "" } = {}) {
  if (!game.user.isGM) return ui.notifications.warn(L("Archive.GMOnly")), null;
  if (getSession()) return ui.notifications.warn(L("Session.AlreadyActive")), null;
  const s = { active: true, number: Number(number) || nextSessionNumber(), title: String(title ?? "").trim(), startedAt: Date.now() };
  const marker = await postMarker("start", s);
  // Use the marker's own timestamp so the session range starts exactly at the marker.
  if (marker) s.startedAt = Math.min(s.startedAt, marker.timestamp);
  await game.settings.set(MODULE_ID, "session", s);
  ui.notifications.info(L("Session.Started", { label: sessionLabel(s) }));
  Hooks.callAll("gctSessionStarted", s);
  return s;
}

/**
 * End the running session (GM): post the end marker, save everything since the session start as an
 * archive tagged with the session, then clear the session.
 * @returns {Promise<object|null>} the archive index entry, or null
 */
export async function endSession({ name = "", deleteAfter = false } = {}) {
  if (!game.user.isGM) return ui.notifications.warn(L("Archive.GMOnly")), null;
  const s = getSession();
  if (!s) return null;
  await postMarker("end", s);
  const count = collectMessages({ from: s.startedAt }).length;
  let entry = null;
  if (count) {
    entry = await saveArchive({
      name: name?.trim() || sessionLabel(s),
      from: s.startedAt,
      to: null,
      deleteAfter,
      extra: { session: { number: s.number, title: s.title, startedAt: s.startedAt, endedAt: Date.now() } },
    });
    if (!entry) return null; // save failed: keep the session running
  } else {
    ui.notifications.info(L("Session.EmptyEnded"));
  }
  await game.settings.set(MODULE_ID, "session", { active: false, number: s.number, title: s.title, startedAt: s.startedAt });
  Hooks.callAll("gctSessionEnded", s, entry);
  return entry;
}

/* -------------------------------------------- */
/*  Dialogs                                     */
/* -------------------------------------------- */

export async function openStartSessionDialog() {
  if (!game.user.isGM) return null;
  if (getSession()) return ui.notifications.warn(L("Session.AlreadyActive")), null;
  const number = nextSessionNumber();
  const content = `<div class="gct-session-form">
    <div class="form-group"><label>${esc(L("Session.Number"))}</label><div class="form-fields"><input type="number" name="number" value="${number}" min="1" step="1"></div></div>
    <div class="form-group"><label>${esc(L("Session.TitleField"))}</label><div class="form-fields"><input type="text" name="title" placeholder="${esc(L("Session.TitlePlaceholder"))}" autofocus></div></div>
    <p class="hint">${esc(L("Session.StartHint"))}</p>
  </div>`;
  const result = await formDialog({
    title: L("Session.StartTitle"),
    icon: "fa-solid fa-flag",
    classes: ["gct-session-dialog"],
    width: 440,
    content,
    ok: { action: "start", label: L("Session.Start"), icon: "fa-solid fa-play", read: (button) => readForm(button) },
    cancel: { label: L("Cancel") },
  });
  if (!result) return null;
  return startSession(result);
}

export async function openEndSessionDialog() {
  const s = getSession();
  if (!game.user.isGM || !s) return null;
  const count = collectMessages({ from: s.startedAt }).length;
  const content = `<div class="gct-session-form">
    <p><strong>${esc(sessionLabel(s))}</strong><br><span class="hint">${esc(L("Session.Since", { time: fmtDateTime(s.startedAt), count }))}</span></p>
    <div class="form-group"><label>${esc(L("Archive.Name"))}</label><div class="form-fields"><input type="text" name="name" value="${esc(sessionLabel(s))}"></div></div>
    <div class="form-group"><label>${esc(L("Archive.DeleteAfter"))}</label><div class="form-fields"><input type="checkbox" name="deleteAfter"></div>
      <p class="hint">${esc(L("Archive.DeleteAfterHint"))}</p></div>
  </div>`;
  const result = await formDialog({
    title: L("Session.EndTitle"),
    icon: "fa-solid fa-flag-checkered",
    classes: ["gct-session-dialog"],
    width: 440,
    content,
    ok: { action: "end", label: L("Session.EndAndSave"), icon: "fa-solid fa-floppy-disk", read: (button) => readForm(button) },
    cancel: { label: L("Cancel") },
  });
  if (!result) return null;
  return endSession({ name: result.name, deleteAfter: !!result.deleteAfter });
}

/* -------------------------------------------- */
/*  Auto archive                                */
/* -------------------------------------------- */

let running = false;
let timer = null;

/** Debounced count check, called whenever a chat message is created. */
export function scheduleAutoArchive(delay = 2000) {
  if (!setting("autoArchiveThreshold")) return;
  clearTimeout(timer);
  timer = setTimeout(() => autoArchiveByCount(), delay);
}

/**
 * When the chat log holds more than the threshold, archive everything not archived yet and remove
 * archived messages from the log, keeping the newest `autoArchiveKeep`. Skipped while a session runs
 * (the session end saves the whole session). Only one GM client runs the automatic jobs (gatos-lib isLeadGM).
 */
export async function autoArchiveByCount() {
  const threshold = Number(setting("autoArchiveThreshold")) || 0;
  if (!threshold || running || !isLeadGM() || getSession()) return;
  if (game.messages.size <= threshold) return;
  running = true;
  try {
    const last = setting("lastArchived");
    const pending = collectMessages({ from: last ? last + 1 : null });
    if (pending.length) {
      const entry = await saveArchive({
        name: L("Auto.Name", { date: fmtDateTime(Date.now()) }),
        from: pending[0].timestamp,
        to: null,
        quiet: true,
        extra: { auto: true },
      });
      if (!entry) return;
    }
    const keep = Math.max(0, Math.min(Number(setting("autoArchiveKeep")) || 0, Math.floor(threshold / 2)));
    const archivedUpTo = setting("lastArchived");
    const all = collectMessages();
    const keepIds = new Set(keep > 0 ? all.slice(-keep).map((m) => m.id) : []);
    const ids = all.filter((m) => m.timestamp <= archivedUpTo && !keepIds.has(m.id)).map((m) => m.id);
    if (ids.length) await deleteMessagesChunked(ids, L("Auto.Deleting", { count: ids.length }));
    ui.notifications.info(L("Auto.Done", { saved: pending.length, deleted: ids.length }));
  } catch (err) {
    mod.error("auto archive failed", err);
  } finally {
    running = false;
  }
}

/**
 * On GM login: archive messages left over from an earlier sitting (not archived yet and the newest
 * of them older than three hours), so a forgotten save does not leave them only in the live log.
 */
export async function autoArchiveOnLoad() {
  if (!setting("autoArchiveOnLoad") || !isLeadGM() || getSession()) return;
  const last = setting("lastArchived");
  const pending = collectMessages({ from: last ? last + 1 : null });
  if (!pending.length) return;
  const newest = pending.at(-1).timestamp;
  if (Date.now() - newest < IDLE_MS) return;
  await saveArchive({
    name: L("Auto.LoadName", { from: fmtDate(pending[0].timestamp), to: fmtDate(newest) }),
    from: pending[0].timestamp,
    to: newest,
    quiet: true,
    extra: { auto: true },
  });
}

/** ready: run the load-time job, then the count check. */
export async function onReadyAutoArchive() {
  try {
    await autoArchiveOnLoad();
  } catch (err) {
    mod.error("auto archive on load failed", err);
  }
  await autoArchiveByCount();
}
