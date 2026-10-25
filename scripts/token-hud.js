import { MODULE_ID, L } from "./constants.js";
import { esc, htmlRoot, metadataButton } from "./lib.js";
import { setting } from "./settings.js";
import { tokenOwners, setWhisperTarget, sendWithTarget } from "./whisper.js";

/*
 * A translucent menu at the top of the screen that appears when a token is clicked (Argon-style).
 * Players cannot "control" tokens they do not own, so Foundry never sends them a click event for
 * those; instead the module listens to clicks on the board itself and looks up the token under the
 * pointer.
 *
 * When the menu appears (covert play: several users share one secret token and whisper through it):
 *  - the token has a player owner other than me (co-owned tokens, including my own PC), or
 *  - I am a player and the token is not my assigned PC (the whisper then reaches at least the GM).
 * A GM has no assigned PC, so for the GM only tokens with player owners count.
 */

const HUD_ID = "gct-token-hud";
let current = null; // TokenDocument the menu is about
let down = null;

/** Players (other than me) who own the token now. */
const recipientsOf = (doc) => tokenOwners(doc).filter((u) => u.id !== game.user.id);

/** Is this token the user's assigned player character? */
const isMyPC = (doc) => !!game.user.character && (doc.actorId === game.user.character.id || doc.actor?.id === game.user.character.id);

/** Should clicking this token open the whisper menu? */
export function menuAppliesTo(doc) {
  if (!doc?.actor) return false;
  if (recipientsOf(doc).length) return true;
  if (game.user.isGM) return false;
  return !isMyPC(doc);
}

/** Topmost visible token under a client (screen) point, or null. */
function tokenAt(clientX, clientY) {
  if (!canvas?.ready) return null;
  const p = canvas.canvasCoordinatesFromClient({ x: clientX, y: clientY });
  const hits = canvas.tokens.placeables.filter((t) => t.visible && t.document && !t.isPreview && t.bounds?.contains(p.x, p.y));
  if (!hits.length) return null;
  hits.sort((a, b) => a.document.elevation - b.document.elevation || a.document.sort - b.document.sort || a.zIndex - b.zIndex);
  return hits.at(-1);
}

function onPointerDown(ev) {
  down = ev.button === 0 ? { x: ev.clientX, y: ev.clientY, t: Date.now() } : null;
}

function onPointerUp(ev) {
  const start = down;
  down = null;
  if (ev.button !== 0 || !start) return;
  if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6 || Date.now() - start.t > 600) return; // drag, not a click
  if (!setting("tokenHud") || !canvas?.ready || !canvas.tokens?.active) return;
  const token = tokenAt(ev.clientX, ev.clientY);
  if (token && menuAppliesTo(token.document)) showTokenHud(token.document);
  else hideTokenHud();
}

/**
 * Who the menu's whisper is spoken as:
 *  - a player who owns the token speaks as that token (the shared covert character);
 *  - otherwise as usual, except never as the token being whispered to (a GM clicking a token selects it).
 */
function speakerFor(doc) {
  if (!game.user.isGM && doc.actor?.testUserPermission(game.user, "OWNER")) return ChatMessage.getSpeaker({ token: doc });
  const s = ChatMessage.getSpeaker();
  if (s.token !== doc.id) return s;
  const character = game.user.character;
  if (character && character.id !== doc.actorId) return ChatMessage.getSpeaker({ actor: character });
  return { scene: null, actor: null, token: null, alias: game.user.name };
}

function targetFor(doc) {
  return { mode: "token", sceneId: doc.parent?.id ?? null, tokenId: doc.id, tokenName: doc.name, users: [], oneShot: false };
}

async function send(hud) {
  const input = hud.querySelector(".gct-th-input");
  const text = input.value.trim();
  if (!text || !current) return;
  const doc = current;
  input.value = "";
  await sendWithTarget(targetFor(doc), text, { speaker: speakerFor(doc) });
  hideTokenHud();
}

function build() {
  const hud = document.createElement("div");
  hud.id = HUD_ID;
  hud.className = "gct-token-hud";
  hud.innerHTML = `
    <div class="gct-th-row">
      <img class="gct-th-img" alt="">
      <div class="gct-th-info"><div class="gct-th-name"></div><div class="gct-th-owners"></div></div>
      <button type="button" class="gct-th-whisper"><i class="fa-solid fa-user-secret"></i> ${esc(L("TokenHud.Whisper"))}</button>
      <button type="button" class="gct-th-pin" data-tooltip="${esc(L("TokenHud.Pin"))}"><i class="fa-solid fa-thumbtack"></i></button>
      <button type="button" class="gct-th-close" data-tooltip="${esc(L("TokenHud.Close"))}"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="gct-th-compose" hidden>
      <input type="text" class="gct-th-input" autocomplete="off">
      <button type="button" class="gct-th-send"><i class="fa-solid fa-paper-plane"></i> ${esc(L("TokenHud.Send"))}</button>
    </div>`;
  const compose = hud.querySelector(".gct-th-compose");
  const input = hud.querySelector(".gct-th-input");
  hud.querySelector(".gct-th-whisper").addEventListener("click", () => {
    compose.hidden = !compose.hidden;
    if (!compose.hidden) input.focus();
  });
  hud.querySelector(".gct-th-pin").addEventListener("click", async () => {
    if (!current) return;
    await setWhisperTarget(targetFor(current));
    ui.notifications.info(L("TokenHud.Pinned", { name: current.name }));
    hideTokenHud();
  });
  hud.querySelector(".gct-th-close").addEventListener("click", () => hideTokenHud());
  hud.querySelector(".gct-th-send").addEventListener("click", () => send(hud));
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // keep Foundry keybindings (WASD, Delete…) out of the text field
    if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      send(hud);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      hideTokenHud();
    }
  });
  document.body.append(hud);
  return hud;
}

function refresh() {
  const hud = document.getElementById(HUD_ID);
  if (!hud || !current) return;
  if (!current.actor) return hideTokenHud();
  const owners = tokenOwners(current);
  const others = owners.filter((u) => u.id !== game.user.id);
  hud.querySelector(".gct-th-img").src = current.texture?.src || current.actor?.img || "icons/svg/mystery-man.svg";
  hud.querySelector(".gct-th-name").textContent = current.name;
  const names = owners.map((u) => (u.id === game.user.id ? L("TokenHud.Me", { name: u.name }) : u.name));
  hud.querySelector(".gct-th-owners").textContent = others.length ? L("TokenHud.Owners", { names: names.join(", ") }) : L("TokenHud.GMOnly");
  const speakAs = !game.user.isGM && current.actor.testUserPermission(game.user, "OWNER");
  hud.querySelector(".gct-th-whisper").dataset.tooltip = speakAs ? L("TokenHud.SpeakAs", { name: current.name }) : "";
  hud.querySelector(".gct-th-input").placeholder = L("TokenHud.Placeholder", { name: current.name });
}

/** Show the menu for a token (also usable from macros: api.whisper.showTokenHud(token)). */
export function showTokenHud(tokenOrDoc, { compose = false } = {}) {
  const doc = tokenOrDoc?.document ?? tokenOrDoc;
  if (!doc) return;
  const hud = document.getElementById(HUD_ID) ?? build();
  const same = current?.id === doc.id;
  current = doc;
  if (!same) {
    hud.querySelector(".gct-th-compose").hidden = true;
    hud.querySelector(".gct-th-input").value = "";
  }
  refresh();
  if (!current) return;
  hud.classList.add("open");
  if (compose) {
    hud.querySelector(".gct-th-compose").hidden = false;
    hud.querySelector(".gct-th-input").focus();
  }
}

/** renderChatMessageHTML: a whisper sent through a token gets a reply button for its recipients and author. */
function onRenderChatMessageReply(message, html) {
  const li = htmlRoot(html);
  const info = message?.flags?.[MODULE_ID]?.whisperTo;
  if (!li || info?.mode !== "token" || !info.tokenId || !message.whisper?.length) return;
  const doc = game.scenes.get(info.sceneId)?.tokens.get(info.tokenId);
  if (!doc) return;
  const meta = li.querySelector(".message-metadata");
  if (!meta || meta.querySelector(".gct-whisper-reply")) return;
  meta.prepend(metadataButton({ cls: "gct-whisper-reply", icon: "fa-solid fa-reply", label: L("TokenHud.Reply", { name: doc.name }), onClick: () => showTokenHud(doc, { compose: true }) }));
}

export function hideTokenHud() {
  current = null;
  document.getElementById(HUD_ID)?.remove();
}

/** Bind the board listeners (the board element survives scene changes; bind once). */
function bindBoard() {
  const board = canvas?.app?.view;
  if (!board || board.dataset.gctTokenHud) return;
  board.dataset.gctTokenHud = "1";
  board.addEventListener("pointerdown", onPointerDown, true);
  board.addEventListener("pointerup", onPointerUp, true);
}

export function registerTokenHudHooks() {
  Hooks.on("renderChatMessageHTML", onRenderChatMessageReply);
  // Esc anywhere closes the menu (Foundry still gets the key for its own dismiss handling).
  window.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key === "Escape" && current) hideTokenHud();
    },
    true
  );
  Hooks.on("canvasReady", () => {
    hideTokenHud();
    bindBoard();
  });
  Hooks.on("canvasTearDown", () => hideTokenHud());
  Hooks.on("deleteToken", (doc) => {
    if (doc.id === current?.id) hideTokenHud();
  });
  Hooks.on("updateToken", (doc) => {
    if (doc.id === current?.id) refresh();
  });
  Hooks.on("updateActor", (actor) => {
    if (current?.actor?.id === actor.id || current?.actorId === actor.id) refresh();
  });
  Hooks.on("updateUser", () => {
    if (current) refresh();
  });
}
