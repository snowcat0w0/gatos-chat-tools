import { MODULE_ID, mod, isNote } from "./constants.js";
import { setting } from "./settings.js";
import { htmlRoot, providerRegistry } from "./lib.js";

/**
 * Look up the current images for a speaker from the world documents.
 * `token` is the image of the speaker's token on its scene (null when the token is not on a map);
 * `actor` is the actor's portrait.
 * @param {object} speaker  A ChatMessage speaker object.
 * @returns {{token: string|null, actor: string|null, actorDoc: Actor|null}}
 */
export function lookupPortrait(speaker) {
  let actorDoc = null;
  let tokenImg = null;
  if (speaker?.scene && speaker?.token) {
    const token = game.scenes.get(speaker.scene)?.tokens.get(speaker.token);
    tokenImg = token?.texture?.src ?? null;
    actorDoc = token?.actor ?? null;
  }
  actorDoc ??= speaker?.actor ? game.actors.get(speaker.actor) : null;
  return { token: tokenImg, actor: actorDoc?.img ?? null, actorDoc };
}

/** The portrait data stored on a message at creation time, if any. */
function storedPortrait(message) {
  const p = message?.flags?.[MODULE_ID]?.portrait;
  return p && (p.token || p.actor) ? p : null;
}

/** gatos-lib providerRegistry: ordered, each provider once, a throwing provider is skipped with a warning. */
const providers = providerRegistry();

/**
 * Register a portrait provider. Providers are asked in registration order before the built-in lookup;
 * the first one returning an image wins. A provider returns a path string, `{img, label}` or null.
 * @param {(message: ChatMessage) => (string|{img: string, label?: string}|null)} fn
 */
export function registerPortraitProvider(fn) {
  if (typeof fn === "function") providers.register(fn);
}

function fromProviders(message) {
  // Lazy walk as in 0.5.2: providers after the first one that returns an image are not called.
  return providers.first((r) => (typeof r === "string" ? { img: r, label: null } : r?.img ? { img: r.img, label: r.label ?? null } : null), message);
}

/**
 * Resolve the portrait image for a message: a registered provider's image first, then the token image
 * when the speaker's token was on a map, otherwise the actor portrait. Uses the images frozen on the
 * message when it was created (flag), so later token/actor image changes do not affect messages
 * already in the log. Messages created before this feature fall back to a live lookup.
 * @param {ChatMessage} message
 * @returns {{img: string|null, actor: Actor|null, label: string|null}}
 */
export function portraitFor(message) {
  const live = lookupPortrait(message?.speaker);
  const provided = fromProviders(message);
  if (provided) return { ...provided, actor: live.actorDoc };
  const data = storedPortrait(message) ?? live;
  return { img: data.token || data.actor || null, actor: live.actorDoc, label: null };
}

/** preCreateChatMessage hook: freeze the speaker's current images onto the message. */
export function onPreCreateChatMessage(message, data, options) {
  if (options?.gctDuplicate) return; // a duplicate keeps the original's frozen portrait
  if (isNote(message)) return; // notes never show a portrait
  const { token, actor } = lookupPortrait(message.speaker);
  if (token || actor) message.updateSource({ [mod.flagKey("portrait")]: { token, actor } });
}

/** Build the flag update that re-freezes the portrait for a new speaker (used when a message's speaker is edited). */
export function portraitFlagUpdate(speaker) {
  const { token, actor } = lookupPortrait(speaker);
  if (token || actor) return { [mod.flagKey("portrait")]: { token, actor } };
  return { [mod.flagDeleteKey("portrait")]: null };
}

/** Add (or refresh) the portrait on a rendered chat message element. */
export function applyPortrait(message, li) {
  if (!(li instanceof HTMLElement) || !message) return;
  li.querySelector(":scope > .gct-portrait, :scope > .message-header > .gct-portrait")?.remove();
  li.classList.remove("gct-has-portrait");
  li.style.removeProperty("--gct-portrait-size");
  if (!setting("showPortrait")) return;
  const header = li.querySelector(":scope > .message-header");
  if (!header) return;

  const { img, actor, label } = portraitFor(message);
  if (!img) return;
  const el = document.createElement("img");
  el.className = `gct-portrait ${setting("portraitShape")}`;
  el.src = img;
  el.alt = message.alias ?? "";
  // Never lazy: the core ChatLog#scrollBottom({waitImages}) waits for every <img> in the log that is not
  // `complete`, and a lazy image outside the viewport never loads, so the auto-scroll would wait forever.
  el.loading = "eager";
  el.decoding = "async";
  el.dataset.tooltip = label ? `${message.alias ?? ""} · ${label}` : message.alias ?? "";
  if (actor?.testUserPermission?.(game.user, "LIMITED")) {
    el.classList.add("clickable");
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      actor.sheet?.render(true);
    });
  }
  li.classList.add("gct-has-portrait");
  li.style.setProperty("--gct-portrait-size", `${setting("portraitSize")}px`);
  header.prepend(el);
}

/**
 * Show the player's (user) name under the character name when the card is spoken as somebody else, e.g.
 * "Goblin" with "Alice" below. Compared with the name the card actually shows, so OOC cards (which show the
 * author) never repeat it. Not on chitchat (always the player's name), notes or session markers.
 */
export function applyPlayerName(message, li) {
  if (!(li instanceof HTMLElement) || !message) return;
  const sender = li.querySelector(":scope > .message-header .message-sender");
  sender?.querySelector(":scope > .gct-player-name")?.remove();
  li.classList.remove("gct-has-player");
  if (!sender || !setting("showPlayerName")) return;
  if (message.flags?.[MODULE_ID]?.chitchat || message.flags?.[MODULE_ID]?.sessionMarker || isNote(message)) return;
  const name = message.author?.name;
  if (!name || sender.textContent.trim() === name) return;
  const span = document.createElement("span");
  span.className = "gct-player-name";
  span.textContent = name;
  sender.append(span);
  li.classList.add("gct-has-player");
}

/** renderChatMessageHTML hook. */
export function onRenderChatMessagePortrait(message, html) {
  const li = htmlRoot(html);
  applyPortrait(message, li);
  applyPlayerName(message, li);
}

/** Re-apply portraits and player names to every chat message currently in the DOM (used when display settings change). */
export function refreshPortraits() {
  for (const li of document.querySelectorAll(".chat-message[data-message-id]")) {
    const message = game.messages.get(li.dataset.messageId);
    if (!message) continue;
    applyPortrait(message, li);
    applyPlayerName(message, li);
  }
}
