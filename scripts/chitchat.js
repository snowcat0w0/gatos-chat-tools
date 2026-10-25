import { MODULE_ID, mod } from "./constants.js";
import { htmlRoot } from "./lib.js";
import { setting } from "./settings.js";

/** Triggers that are always recognised, in addition to the user-defined one. */
export const FIXED_TRIGGERS = ["/pt", "`", "!"];

/** All chitchat triggers, longest first so "/pt" wins over "/p". */
export function chitchatTriggers() {
  let custom = "";
  try {
    custom = (setting("chitchatTrigger") ?? "").trim();
  } catch {
    custom = "";
  }
  return [...new Set([...FIXED_TRIGGERS, custom].filter((t) => t))].sort((a, b) => b.length - a.length);
}

/**
 * Does this chat input start with a chitchat trigger?
 * Slash triggers need a following space ("/pt hello"); symbol triggers match directly ("`hello").
 * @returns {{body: string}|null}
 */
export function matchChitchat(text) {
  if (!text) return null;
  const lead = /^(?:\s|<[^>]*>)*/.exec(text)?.[0] ?? "";
  const rest = text.slice(lead.length);
  for (const trigger of chitchatTriggers()) {
    const prefix = trigger.startsWith("/") ? `${trigger} ` : trigger;
    if (!rest.startsWith(prefix)) continue;
    const body = rest.slice(prefix.length);
    if (!body.replace(/<[^>]*>/g, "").trim()) return null;
    return { body };
  }
  return null;
}

/**
 * Rendered chitchat HTML carries this module's "name + text" wrapper (added by the render hook).
 * Return only the message text so archives, the viewer and exports do not show the name twice.
 */
export function stripChitchatMarkup(html) {
  if (!html || !html.includes("gct-cc-text")) return html;
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  let node = doc.getElementById("root");
  let inner;
  while ((inner = node.querySelector(".gct-cc-text"))) node = inner;
  return node.innerHTML.trim();
}

/** The name a chitchat message is shown under: always the sending player's (user) name. */
export function chitchatName(message) {
  return message?.author?.name ?? message?.user ?? message?.alias ?? "";
}

/** Is this message (document or serialized archive entry) a chitchat message? */
export function isChitchat(message) {
  return !!(message?.flags?.[MODULE_ID]?.chitchat || message?.chitchat);
}

function htmlToPlainText(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent ?? "").trim();
}

/** chatMessage hook: turn trigger-prefixed input into a chitchat message and suppress default handling. */
export function onChatMessage(chatLog, text, chatData) {
  const matched = matchChitchat(text);
  if (!matched) return;
  const plain = htmlToPlainText(matched.body);
  const style = setting("chitchatAsOOC") ? CONST.CHAT_MESSAGE_STYLES.OOC : CONST.CHAT_MESSAGE_STYLES.OTHER;
  const data = {
    ...chatData,
    author: game.user.id,
    speaker: { scene: null, actor: null, token: null, alias: game.user.name },
    style,
    content: foundry.utils.escapeHTML(plain),
    flags: foundry.utils.mergeObject(chatData.flags ?? {}, { [MODULE_ID]: { chitchat: true } }),
  };
  delete data.user;
  ChatMessage.create(data).catch((err) => mod.error("chitchat create failed", err));
  return false;
}

/** Pastel background for a user colour: mix with white by `brightness` (0 = pure colour, 1 = white). */
export function pastelOf(color, brightness) {
  let rgb = [136, 136, 136];
  try {
    const c = foundry.utils.Color.from(color ?? "#888888");
    rgb = [c.r, c.g, c.b].map((v) => Math.round(v * 255));
  } catch {
    /* keep grey */
  }
  const b = Math.min(Math.max(Number(brightness) || 0, 0), 1);
  const mix = rgb.map((v) => Math.round(v * (1 - b) + 255 * b));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

/** The colour of a message's author (document or serialized entry), as a CSS string. */
export function authorColor(message) {
  const c = message?.author?.color ?? message?.color;
  if (!c) return "#888888";
  return c.css ?? (typeof c === "string" ? c : String(c));
}

/** renderChatMessageHTML hook: compact chitchat markup (name inline, user-coloured background, header collapsed). */
export function applyChitchatMarkup(message, li) {
  if (!(li instanceof HTMLElement) || !isChitchat(message)) return;
  li.classList.add("gct-chitchat");
  li.classList.toggle("gct-cc-break", !!setting("chitchatLineBreak"));
  const color = authorColor(message);
  li.style.setProperty("--gct-cc-color", color);
  li.style.setProperty("--gct-cc-bg", pastelOf(color, setting("chitchatBrightness")));
  li.style.removeProperty("border-color");
  const content = li.querySelector(".message-content");
  if (content && !content.querySelector(".gct-cc-text")) {
    const body = content.innerHTML;
    content.innerHTML = `<span class="gct-cc-name"></span><span class="gct-cc-text"></span>`;
    content.querySelector(".gct-cc-name").textContent = chitchatName(message);
    content.querySelector(".gct-cc-text").innerHTML = body;
  }
}

export function onRenderChatMessageChitchat(message, html) {
  applyChitchatMarkup(message, htmlRoot(html));
}

/** Apply the chitchat font-size preference as a CSS variable on the document. */
export function applyChitchatCssVars() {
  document.documentElement.style.setProperty("--gct-cc-font-size", `${setting("chitchatFontSize")}px`);
}
