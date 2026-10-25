import { MODULE_ID } from "./constants.js";
import { chatLogElements } from "./lib.js";
import { setting } from "./settings.js";
import { isChitchat } from "./chitchat.js";

function speakerKey(s) {
  return s?.token ?? s?.actor ?? s?.alias ?? "";
}
function whisperKey(m) {
  return [...(m?.whisper ?? [])].map(String).sort().join(",");
}

/**
 * Key that decides whether two consecutive messages belong to one visual group.
 * Returns null when the message must never be grouped.
 */
export function groupKey(m) {
  if (!m) return null;
  if (m.flags?.[MODULE_ID]?.sessionMarker) return null;
  if (isChitchat(m)) return setting("groupChitchat") ? "cc" : null;
  if (!setting("groupMessages")) return null;
  const author = m.author?.id ?? m._source?.author ?? m.userId ?? "";
  return `m|${author}|${speakerKey(m.speaker)}|${m.style}|${whisperKey(m)}|${m.blind ? 1 : 0}`;
}

/** Maximum gap (ms) between two messages of one group; 0 = unlimited. */
function maxGap() {
  const minutes = Number(setting("groupGapMinutes")) || 0;
  return minutes > 0 ? minutes * 60000 : 0;
}

const CLASSES = ["gct-group-top", "gct-group-middle", "gct-group-end", "gct-cont"];

/** Assign group classes to every message element of one chat log. */
function regroupLog(log) {
  const items = [...log.querySelectorAll(":scope > .chat-message[data-message-id]")].filter((li) => !li.classList.contains("deleting"));
  const gap = maxGap();
  const info = items.map((li) => {
    const m = game.messages.get(li.dataset.messageId);
    return { li, key: groupKey(m), ts: m?.timestamp ?? 0 };
  });
  const joined = (a, b) => a.key != null && a.key === b.key && (!gap || Math.abs(b.ts - a.ts) <= gap);
  for (let i = 0; i < info.length; i++) {
    const cur = info[i];
    const prev = i > 0 && joined(info[i - 1], cur);
    const next = i < info.length - 1 && joined(cur, info[i + 1]);
    cur.li.classList.remove(...CLASSES);
    if (prev && next) cur.li.classList.add("gct-group-middle", "gct-cont");
    else if (prev) cur.li.classList.add("gct-group-end", "gct-cont");
    else if (next) cur.li.classList.add("gct-group-top");
  }
}

/** Regroup every chat log on the page (sidebar and popout; notifications are left alone). */
export function regroupAll() {
  for (const log of chatLogElements()) regroupLog(log);
}

let timer = null;
/** Debounced regroup, used from render/delete hooks. */
export function scheduleRegroup(delay = 30) {
  clearTimeout(timer);
  timer = setTimeout(regroupAll, delay);
}

/** Group a list of serialized messages (viewer / export): returns a parallel array of "top" | "middle" | "end" | null. */
export function groupSerialized(messages) {
  const gap = maxGap();
  const key = (m) => {
    if (m.sessionMarker) return null;
    if (m.chitchat) return setting("groupChitchat") ? "cc" : null;
    if (!setting("groupMessages")) return null;
    return `m|${m.userId ?? ""}|${m.token ?? m.actor ?? m.alias ?? ""}|${m.style}|${(m.whisper ?? []).join(",")}|${m.blind ? 1 : 0}`;
  };
  const keys = messages.map(key);
  const joined = (i, j) => keys[i] != null && keys[i] === keys[j] && (!gap || Math.abs(messages[j].timestamp - messages[i].timestamp) <= gap);
  return messages.map((m, i) => {
    const prev = i > 0 && joined(i - 1, i);
    const next = i < messages.length - 1 && joined(i, i + 1);
    if (prev && next) return "middle";
    if (prev) return "end";
    if (next) return "top";
    return null;
  });
}
