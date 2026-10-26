import { L, mod } from "./constants.js";
import { onChatUiRender } from "./lib.js";
import { setting } from "./settings.js";
import { socket } from "./socket.js";
import { matchChitchat } from "./chitchat.js";
import { getWhisperTarget } from "./whisper.js";
import { chatInputElement, chatInputText, onChatInputChange } from "./chat-input.js";

/*
 * Typing indicator: "A, B님이 입력 중입니다" right above the chat input.
 *
 * Sender: while the chat input holds text that would become a PUBLIC message, ping everyone at most every
 * SEND_EVERY ms; send "stop" as soon as the text is cleared or turns private, when one of my messages is
 * created, and when the input (the v13 chat <textarea>) loses focus. GMs only broadcast when `typingShowGM` is on.
 * Receiver: the server-supplied sender (gatos-lib socket) is trusted, never a payload id; an entry expires
 * EXPIRE_AFTER ms after its last ping, and is dropped when that user posts or disconnects.
 * When another module already provides an indicator (coc7-ko, Cautious Gamemaster's Pack) this one yields:
 * no line, no pings.
 */

const SEND_EVERY = 2000;
const EXPIRE_AFTER = 3500;
const LINE_CLASS = "gct-typing";
const BAR_SELECTOR = ".gct-speaker-bar, .gct-whisper-bar";

/** Core chat commands that always post a public message (ChatLog.CHAT_COMMANDS ic / ooc / emote and aliases). */
const PUBLIC_COMMAND = /^\/(?:ic|ooc|em|emote|me)\s/i;

/* -------------------------------------------- */
/*  Policy                                      */
/* -------------------------------------------- */

/** Another active module providing a typing indicator, or null. */
export function otherProvider() {
  const on = (id, key) => {
    if (!game.modules.get(id)?.active) return false;
    try {
      return !!game.settings.get(id, key);
    } catch {
      return false; // setting not registered (other version of that module)
    }
  };
  if (on("coc7-ko", "typingIndicator")) return "coc7-ko";
  if (on("CautiousGamemastersPack", "notifyTyping")) return "CautiousGamemastersPack";
  return null;
}

/** Is the indicator on for this client (setting on, nobody else providing one)? */
export function typingActive() {
  return !!setting("typingIndicator") && !otherProvider();
}

/** May this user announce their typing? GMs only when the world allows it. */
const canBroadcast = () => !game.user.isGM || !!setting("typingShowGM");

/**
 * Classify the chat input text: "empty", "public" (worth announcing) or "private".
 * v13 has no core message mode for plain chat: ChatLog#processMessage turns plain text into an "ic" / "ooc"
 * message created without a rollMode (the `core.rollMode` setting and the #roll-privacy buttons only apply to
 * dice commands, ChatLog#processDiceCommand / ChatMessage#_preCreate), so only our whisper target makes it private.
 * - chitchat triggers are normal speech and honour the whisper target;
 * - /ic /ooc /emote /em /me always post publicly (our whisper target leaves slash commands alone);
 * - any other slash command (/w, /whisper, /gm, /r, /macro, …) is private, a roll or not a message;
 * - plain text is public when no whisper target is chosen.
 */
export function classifyInput(text) {
  const t = String(text ?? "").replace(/ /g, " ").trim();
  if (!t) return "empty";
  const whisperPublic = getWhisperTarget()?.mode === "public";
  if (matchChitchat(t)) return whisperPublic ? "public" : "private";
  if (t.startsWith("/")) {
    const m = PUBLIC_COMMAND.exec(t);
    if (!m) return "private";
    return t.slice(m[0].length).trim() ? "public" : "empty";
  }
  return whisperPublic ? "public" : "private";
}

/* -------------------------------------------- */
/*  Sender                                      */
/* -------------------------------------------- */

let lastPing = 0;
let announced = false;

/** The chat input changed: ping (throttled) or stop. */
function onLocalInput() {
  if (!typingActive() || !canBroadcast()) return stopLocal();
  if (classifyInput(chatInputText()) !== "public") return stopLocal();
  const now = Date.now();
  if (now - lastPing < SEND_EVERY) return;
  lastPing = now;
  announced = true;
  socket.broadcast("typing", { on: true });
}

/** Tell the others I stopped, once. */
function stopLocal() {
  if (!announced) return;
  announced = false;
  lastPing = 0;
  socket.broadcast("typing", { on: false });
}

/* -------------------------------------------- */
/*  Receiver                                    */
/* -------------------------------------------- */

/** userId → { name, expires } */
const typers = new Map();
let expiryTimer = null;

function onTypingMessage(data, user) {
  if (!user || user.isSelf) return;
  if (data?.on) {
    if (!typingActive()) return;
    if (user.isGM && !setting("typingShowGM")) return;
    typers.set(user.id, { name: user.name, expires: Date.now() + EXPIRE_AFTER });
  } else typers.delete(user.id);
  scheduleExpiry();
  renderLines();
}

/** Drop expired entries and re-arm the timer for the next expiry. */
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  const now = Date.now();
  let changed = false;
  for (const [id, entry] of typers) {
    if (entry.expires <= now) {
      typers.delete(id);
      changed = true;
    }
  }
  if (changed) renderLines();
  if (!typers.size) return;
  const next = Math.min(...[...typers.values()].map((e) => e.expires));
  expiryTimer = setTimeout(scheduleExpiry, Math.max(50, next - now + 10));
}

/** "A님이 입력 중입니다" / "A, B님이 …" / "여러 명이 …" (4 or more). */
export function typingLabel(names) {
  if (!names.length) return "";
  if (names.length >= 4) return L("Typing.Many");
  if (names.length === 1) return L("Typing.One", { name: names[0] });
  return L("Typing.Some", { names: names.slice(0, -1).join(", "), last: names.at(-1) });
}

function currentNames() {
  return [...typers.entries()].map(([id, e]) => game.users.get(id)?.name ?? e.name).filter(Boolean);
}

/* -------------------------------------------- */
/*  DOM                                         */
/* -------------------------------------------- */

let resizeObserver = null;

/** The topmost of the bars stacked directly above the input (speaker bar, whisper bar), or the input itself. */
function stackTop(input) {
  let top = input;
  while (top.previousElementSibling?.matches?.(BAR_SELECTOR)) top = top.previousElementSibling;
  return top;
}

/**
 * In the notifications area (sidebar collapsed) #chat-notifications is a CSS grid: the line floats (absolute)
 * just above the input stack instead of adding a grid row. In the sidebar / popout form it is a normal flex
 * child with a fixed height, so the log above never jumps.
 */
function positionLine(line) {
  const input = chatInputElement();
  const host = line.parentElement;
  const floating = !!input && host?.id === "chat-notifications";
  line.classList.toggle("gct-typing-float", floating);
  if (!floating) {
    line.style.removeProperty("bottom");
    return;
  }
  // offsetTop is in the host's own (unscaled) CSS pixels, unlike getBoundingClientRect under the UI scale.
  const top = stackTop(input);
  line.style.bottom = `${Math.max(0, host.clientHeight - top.offsetTop)}px`;
}

function createLine() {
  const line = document.createElement("div");
  line.className = `${LINE_CLASS} idle`;
  line.setAttribute("aria-live", "off");
  line.innerHTML = `<span class="gct-typing-text"></span><span class="gct-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>`;
  return line;
}

/** Refresh the text of the line (there is only one input, so at most one line). */
function renderLines() {
  const label = typingLabel(currentNames());
  for (const line of document.querySelectorAll(`.${LINE_CLASS}`)) {
    line.querySelector(".gct-typing-text").textContent = label;
    line.classList.toggle("idle", !label);
    line.dataset.tooltip = label;
  }
}

/** Mount (or move) the line above the input stack; remove it when the indicator is off. */
export function mountTypingLine() {
  const input = chatInputElement();
  let line = document.querySelector(`.${LINE_CLASS}`);
  if (!input || !typingActive()) {
    line?.remove();
    resizeObserver?.disconnect();
    return;
  }
  line ??= createLine();
  const top = stackTop(input);
  if (line.nextElementSibling !== top) top.before(line);
  bindInput(input);
  renderLines();
  positionLine(line);
  // Notifications mode: follow the input's height (it grows on focus) and the bars appearing/disappearing.
  resizeObserver ??= new ResizeObserver(() => {
    const l = document.querySelector(`.${LINE_CLASS}`);
    if (l) positionLine(l);
  });
  resizeObserver.disconnect();
  resizeObserver.observe(input);
  if (line.parentElement) resizeObserver.observe(line.parentElement);
  input.parentElement?.querySelectorAll(`:scope > ${BAR_SELECTOR.split(", ").join(", :scope > ")}`).forEach((bar) => resizeObserver.observe(bar));
}

/** DOM listeners on the input element (core moves the same textarea around, so bind once). Edits arrive via onChatInputChange. */
function bindInput(input) {
  if (input.dataset.gctTypingBound) return;
  input.dataset.gctTypingBound = "1";
  input.addEventListener("focusout", () => stopLocal());
}

/* -------------------------------------------- */
/*  Hooks & API                                 */
/* -------------------------------------------- */

/** Register the hooks (module load). The socket handler is registered here; socket.init() runs in ready. */
export function registerTypingHooks() {
  socket.registerHandler("typing", onTypingMessage, { anyClient: true });
  onChatInputChange(() => onLocalInput());
  // After the speaker / whisper bars (registered earlier), so the line goes on top of them.
  onChatUiRender(() => mountTypingLine());
  Hooks.on("gctSpeakerBarMounted", () => mountTypingLine());
  Hooks.on("createChatMessage", (message) => {
    const authorId = message.author?.id;
    if (authorId === game.user.id) stopLocal();
    else if (authorId && typers.delete(authorId)) renderLines();
  });
  Hooks.on("userConnected", (user, connected) => {
    if (!connected && typers.delete(user.id)) renderLines();
  });
  // Whisper target (a user flag) switched to private while text is pending.
  Hooks.on("updateUser", (user) => {
    if (user.isSelf && announced && classifyInput(chatInputText()) !== "public") stopLocal();
  });
  window.addEventListener("beforeunload", () => stopLocal());
}

/** Setting changes (typingIndicator / typingShowGM). */
export function onTypingSettingChanged() {
  if (!typingActive()) {
    typers.clear();
    stopLocal();
  }
  if (!canBroadcast()) stopLocal();
  mountTypingLine();
}

/** Console helpers: `game.modules.get("gatos-chat-tools").api.typing.status()` / `.test()`. */
export const typingApi = {
  /** Current state, also printed to the console. */
  status() {
    const info = {
      enabled: !!setting("typingIndicator"),
      yieldedTo: otherProvider(),
      active: typingActive(),
      broadcasting: canBroadcast(),
      announced,
      lastPing: lastPing ? new Date(lastPing).toLocaleTimeString() : null,
      inputKind: classifyInput(chatInputText()),
      typing: currentNames(),
      lineMounted: !!document.querySelector(`.${LINE_CLASS}`),
    };
    mod.log("typing status", info);
    return info;
  },
  /** Show fake typers on this client only (no socket traffic). */
  test(names = ["Alice", "Bob"], ms = 5000) {
    const list = [names].flat().filter(Boolean);
    list.forEach((name, i) => typers.set(`gct-test-${i}`, { name, expires: Date.now() + ms }));
    mountTypingLine();
    scheduleExpiry();
    renderLines();
    return currentNames();
  },
  classifyInput,
};
