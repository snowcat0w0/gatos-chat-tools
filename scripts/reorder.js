import { MODULE_ID, L, isNote } from "./constants.js";
import { chatLogElements, pushMessageContextOption } from "./lib.js";
import { scheduleRegroup } from "./grouping.js";

/*
 * Foundry sorts chat messages by timestamp when the world loads, but the live chat log keeps creation
 * order. Moving a message therefore means changing its timestamp and re-sorting the client collection
 * and DOM, so every client sees the same order without reloading.
 */

/** Re-sort game.messages by timestamp (stable) without touching the collection's source data. */
export function resortMessages() {
  const entries = [...Map.prototype.entries.call(game.messages)];
  const sorted = entries
    .map((e, i) => [e, i])
    .sort((a, b) => a[0][1].timestamp - b[0][1].timestamp || a[1] - b[1])
    .map((x) => x[0]);
  if (sorted.every((e, i) => e === entries[i])) return false;
  Map.prototype.clear.call(game.messages);
  for (const [k, v] of sorted) Map.prototype.set.call(game.messages, k, v);
  return true;
}

/** Move a message's rendered element to its place in every chat log (sidebar and popout). */
export function placeMessageElement(message) {
  const msgs = game.messages.contents;
  const idx = msgs.indexOf(message);
  if (idx < 0) return;
  for (const log of chatLogElements()) {
    const li = log.querySelector(`:scope > .chat-message[data-message-id="${message.id}"]`);
    if (!li) continue;
    let placed = false;
    for (let j = idx + 1; j < msgs.length; j++) {
      const next = log.querySelector(`:scope > .chat-message[data-message-id="${msgs[j].id}"]`);
      if (next) {
        if (next !== li) next.before(li);
        placed = true;
        break;
      }
    }
    if (!placed) log.append(li);
  }
}

/** updateChatMessage: a changed timestamp re-sorts the log on every client. */
export function onUpdateChatMessageOrder(message, changes) {
  if (!("timestamp" in (changes ?? {}))) return;
  resortMessages();
  placeMessageElement(message);
  scheduleRegroup();
}

/** createChatMessage: a message created with an older timestamp (a duplicate) is moved into place. */
export function onCreateChatMessageOrder(message, options) {
  const last = game.messages.contents.at(-2);
  if (!last || (message.timestamp >= last.timestamp && !options?.gctDuplicate)) return;
  setTimeout(() => {
    resortMessages();
    placeMessageElement(message);
    scheduleRegroup();
  }, 150);
}

/* -------------------------------------------- */
/*  Actions (GM)                                */
/* -------------------------------------------- */

/** Swap a message with its previous (dir -1) or next (dir +1) neighbour. */
export async function moveMessage(message, dir) {
  if (!game.user.isGM || !message) return;
  resortMessages();
  // Hidden notes are not neighbours: moving past one would look like nothing happened.
  const msgs = game.messages.contents.filter((m) => !isNote(m));
  const i = msgs.indexOf(message);
  const other = msgs[i + dir];
  if (i < 0 || !other) return ui.notifications.warn(L("Reorder.NoNeighbour"));
  if (other.timestamp === message.timestamp) {
    await message.update({ timestamp: other.timestamp + dir });
  } else {
    await ChatMessage.updateDocuments([
      { _id: message.id, timestamp: other.timestamp },
      { _id: other.id, timestamp: message.timestamp },
    ]);
  }
}

/** Set a message's timestamp (used by the edit dialog). */
export async function setMessageTimestamp(message, timestamp) {
  if (!game.user.isGM || !message || !Number.isFinite(timestamp)) return;
  await message.update({ timestamp });
}

/** Create a copy of a message right after the original, keeping speaker, portrait and flags. */
export async function duplicateMessage(message) {
  if (!game.user.isGM || !message) return null;
  resortMessages();
  const msgs = game.messages.contents.filter((m) => !isNote(m));
  const next = msgs[msgs.indexOf(message) + 1];
  const data = message.toObject();
  delete data._id;
  // Halfway to the next message keeps the copy directly below the original.
  const gap = next ? next.timestamp - message.timestamp : 2;
  data.timestamp = message.timestamp + (gap >= 2 ? Math.floor(gap / 2) : 0);
  if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID].highlight;
  return ChatMessage.create(data, { gctDuplicate: true });
}

export function onGetChatMessageContextOptionsReorder(app, options) {
  const gm = () => game.user.isGM;
  pushMessageContextOption(options, { name: "GCT.Reorder.Up", icon: '<i class="fa-solid fa-arrow-up"></i>', condition: gm, callback: (m) => moveMessage(m, -1) });
  pushMessageContextOption(options, { name: "GCT.Reorder.Down", icon: '<i class="fa-solid fa-arrow-down"></i>', condition: gm, callback: (m) => moveMessage(m, 1) });
  pushMessageContextOption(options, { name: "GCT.Reorder.Duplicate", icon: '<i class="fa-solid fa-clone"></i>', condition: gm, callback: (m) => duplicateMessage(m) });
}

/** "YYYY-MM-DDTHH:MM:SS" in local time, for <input type="datetime-local" step="1"> (gatos-lib util/time). */
export { toLocalInput } from "./lib.js";
