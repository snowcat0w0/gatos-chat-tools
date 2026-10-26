import { MODULE_ID, L, mod, isNote } from "./constants.js";
import { onChatUiRender, userFlagStore } from "./lib.js";
import { setting } from "./settings.js";
import { matchChitchat, isChitchat } from "./chitchat.js";
import { onPreCreateChatMessage as freezePortrait } from "./portrait.js";

const DEFAULT_IMG = "icons/svg/mystery-man.svg";
const LOCK_FLAG = "lockedSpeaker";
const FAV_FLAG = "favoriteSpeakers";
const FAV_MAX = 12;
const BAR_CLASS = "gct-speaker-bar";

/* -------------------------------------------- */
/*  State (user flags)                          */
/* -------------------------------------------- */

/** gatos-lib user flag stores: the locked speaker snapshot (null = none) and the favourite list. */
const lockStore = userFlagStore(mod, LOCK_FLAG, { default: null });
const favStore = userFlagStore(mod, FAV_FLAG, { default: [] });

export function getLockedSpeaker() {
  return lockStore.get();
}

async function setLockedSpeaker(value) {
  await lockStore.set(value || null); // null unsets the flag
  updateSpeakerBar();
}

export function getFavorites() {
  return favStore.get();
}

async function setFavorites(list) {
  await favStore.set(list);
  updateSpeakerBar();
}

function sameSpeaker(a, b) {
  return !!a && !!b && a.sceneId === b.sceneId && a.tokenId === b.tokenId && a.actorId === b.actorId;
}

/* -------------------------------------------- */
/*  Resolution                                  */
/* -------------------------------------------- */

function lookup(ref) {
  const scene = ref?.sceneId ? game.scenes.get(ref.sceneId) : null;
  const token = scene && ref?.tokenId ? scene.tokens.get(ref.tokenId) : null;
  const actor = token?.actor ?? (ref?.actorId ? game.actors.get(ref.actorId) : null);
  return { scene, token, actor };
}

/**
 * Who will the next message be spoken as?
 * Priority: locked speaker → controlled token → assigned character → user.
 */
export function resolveCurrentSpeaker() {
  const locked = getLockedSpeaker();
  if (locked) {
    const { token, actor } = lookup(locked);
    return {
      img: token?.texture?.src ?? actor?.img ?? DEFAULT_IMG,
      name: locked.alias ?? token?.name ?? actor?.name ?? game.user.name,
      locked: true,
      stale: !token && !actor,
      actor,
      token,
      sceneId: locked.sceneId ?? null,
    };
  }
  const controlled = canvas?.tokens?.controlled?.[0];
  if (controlled) {
    const doc = controlled.document;
    return { img: doc.texture?.src ?? controlled.actor?.img ?? DEFAULT_IMG, name: doc.name, locked: false, actor: controlled.actor, token: doc, sceneId: canvas.scene?.id ?? null };
  }
  const character = game.user.character;
  if (character) return { img: character.img ?? DEFAULT_IMG, name: character.name, locked: false, actor: character, token: null, sceneId: null };
  return { img: game.user.avatar || DEFAULT_IMG, name: game.user.name, locked: false, actor: null, token: null, sceneId: null };
}

function snapshot(info) {
  return { sceneId: info.token ? info.sceneId : null, tokenId: info.token?.id ?? null, actorId: info.actor?.id ?? null, alias: info.name };
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

async function toggleLock() {
  if (getLockedSpeaker()) {
    await setLockedSpeaker(null);
    ui.notifications.info(L("SpeakerBar.Unlocked"));
    return;
  }
  const info = resolveCurrentSpeaker();
  if (!info.actor && !info.token) return ui.notifications.warn(L("SpeakerBar.NothingToLock"));
  await setLockedSpeaker(snapshot(info));
  ui.notifications.info(L("SpeakerBar.Locked", { name: info.name }));
}

async function addCurrentToFavorites() {
  const info = resolveCurrentSpeaker();
  if (!info.actor && !info.token) return ui.notifications.warn(L("SpeakerBar.NothingToLock"));
  const favs = getFavorites();
  const snap = snapshot(info);
  if (favs.some((f) => sameSpeaker(f, snap))) return ui.notifications.warn(L("SpeakerBar.FavDuplicate"));
  if (favs.length >= FAV_MAX) return ui.notifications.warn(L("SpeakerBar.FavFull"));
  await setFavorites([...favs, snap]);
}

/* -------------------------------------------- */
/*  DOM                                         */
/* -------------------------------------------- */

function createBar() {
  const bar = document.createElement("div");
  bar.className = BAR_CLASS;
  bar.innerHTML = `
    <img class="gct-sb-portrait" src="${DEFAULT_IMG}" alt="">
    <span class="gct-sb-name">—</span>
    <span class="gct-sb-chitchat"><i class="fa-solid fa-comment-dots"></i> ${L("Chitchat.Label")}</span>
    <a class="gct-sb-lock" data-tooltip="${L("SpeakerBar.LockTooltip")}"><i class="fa-solid fa-lock-open"></i></a>
    <div class="gct-sb-favs"></div>`;
  bar.querySelector(".gct-sb-lock").addEventListener("click", (ev) => {
    ev.preventDefault();
    toggleLock();
  });
  bar.querySelector(".gct-sb-portrait").addEventListener("click", () => {
    const { actor } = resolveCurrentSpeaker();
    actor?.sheet?.render(true);
  });
  bar.querySelector(".gct-sb-favs").addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.closest(".gct-sb-reset")) return void setLockedSpeaker(null);
    if (t.closest(".gct-sb-add")) return void addCurrentToFavorites();
    const chip = t.closest(".gct-sb-chip");
    if (!chip) return;
    const index = Number(chip.dataset.index);
    const favs = getFavorites();
    if (t.closest(".gct-sb-chip-remove")) {
      ev.stopPropagation();
      return void setFavorites(favs.filter((_, i) => i !== index));
    }
    if (favs[index]) void setLockedSpeaker(favs[index]);
  });
  return bar;
}

function renderFavorites(strip) {
  if (!setting("speakerFavorites")) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }
  strip.hidden = false;
  strip.innerHTML = "";
  const locked = getLockedSpeaker();
  const reset = document.createElement("a");
  reset.className = `gct-sb-reset${locked ? "" : " active"}`;
  reset.dataset.tooltip = L("SpeakerBar.ResetTooltip");
  reset.innerHTML = '<i class="fa-solid fa-arrow-rotate-left"></i>';
  strip.append(reset);

  const mode = setting("favoriteChipMode");
  getFavorites().forEach((fav, index) => {
    const { token, actor } = lookup(fav);
    const img = token?.texture?.src ?? actor?.img ?? DEFAULT_IMG;
    const name = fav.alias ?? token?.name ?? actor?.name ?? "?";
    const chip = document.createElement("a");
    chip.className = `gct-sb-chip${mode === "name" ? " mode-name" : ""}${sameSpeaker(fav, locked) ? " active" : ""}${!token && !actor ? " stale" : ""}`;
    chip.dataset.index = String(index);
    chip.dataset.tooltip = name;
    if (mode === "name") {
      const label = document.createElement("span");
      label.className = "gct-sb-chip-label";
      label.textContent = name;
      chip.append(label);
    } else {
      const im = document.createElement("img");
      im.src = img;
      im.alt = name;
      chip.append(im);
    }
    const remove = document.createElement("span");
    remove.className = "gct-sb-chip-remove";
    remove.textContent = "×";
    chip.append(remove);
    strip.append(chip);
  });

  const add = document.createElement("a");
  add.className = "gct-sb-add";
  add.dataset.tooltip = L("SpeakerBar.AddTooltip");
  add.textContent = "+";
  strip.append(add);
}

/** Refresh portrait, name, lock state and favourites of every mounted bar. */
export function updateSpeakerBar() {
  for (const bar of document.querySelectorAll(`.${BAR_CLASS}`)) {
    const info = resolveCurrentSpeaker();
    // Extension point: listeners may replace info.img (e.g. with the current expression's face).
    Hooks.callAll("gctSpeakerBarResolve", info);
    bar.querySelector(".gct-sb-portrait").src = info.img;
    bar.querySelector(".gct-sb-name").textContent = info.name;
    bar.classList.toggle("locked", info.locked);
    bar.classList.toggle("stale", !!info.stale);
    const icon = bar.querySelector(".gct-sb-lock i");
    icon.className = `fa-solid ${info.locked ? "fa-lock" : "fa-lock-open"}`;
    renderFavorites(bar.querySelector(".gct-sb-favs"));
    Hooks.callAll("gctSpeakerBarUpdated", bar, info);
  }
}

function updateChitchatMode(textarea) {
  const on = !!matchChitchat(textarea.value);
  for (const bar of document.querySelectorAll(`.${BAR_CLASS}`)) bar.classList.toggle("gct-cc-mode", on);
}

/** Mount (or re-mount) the bar directly above the chat textarea. */
export function mountSpeakerBar(textarea) {
  textarea ??= document.getElementById("chat-message");
  if (!textarea) return;
  document.querySelectorAll(`.${BAR_CLASS}`).forEach((b) => b.remove());
  if (!setting("speakerBar")) return;
  const bar = createBar();
  textarea.before(bar);
  Hooks.callAll("gctSpeakerBarMounted", bar);
  if (!textarea.dataset.gctSpeakerBound) {
    textarea.dataset.gctSpeakerBound = "1";
    textarea.addEventListener("input", () => updateChitchatMode(textarea));
    textarea.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) setTimeout(() => updateChitchatMode(textarea), 0);
    });
  }
  updateSpeakerBar();
  updateChitchatMode(textarea);
}

/** renderChatInput hook. */
export function onRenderChatInput(app, elements) {
  mountSpeakerBar(elements?.["#chat-message"] ?? null);
}

/* -------------------------------------------- */
/*  Message override                            */
/* -------------------------------------------- */

/**
 * preCreateChatMessage: speak as the locked speaker (not for chitchat, not for other users' messages).
 * Always ends with the `gctSpeakerResolved` hook so other modules can act on the final speaker.
 */
export function onPreCreateChatMessage(message, data, options, userId) {
  // Duplicates keep the original speaker; session markers speak as the module; notes are the user's own.
  if (options?.gctDuplicate || message.flags?.[MODULE_ID]?.sessionMarker || isNote(message)) return;
  applyLockedSpeaker(message, data, userId);
  Hooks.callAll("gctSpeakerResolved", message, data, options, userId);
}

function applyLockedSpeaker(message, data, userId) {
  if (userId !== game.user.id) return;
  if (isChitchat(message)) return;
  const locked = getLockedSpeaker();
  if (!locked) return;
  const { token, actor } = lookup(locked);
  if (!token && !actor) return;
  const speaker = {
    scene: token ? locked.sceneId : null,
    actor: actor?.id ?? null,
    token: token?.id ?? null,
    alias: locked.alias ?? token?.name ?? actor?.name ?? game.user.name,
  };
  const update = { speaker };
  // v13 shows the author's name for OOC messages regardless of speaker, so a locked speaker speaks in character.
  if (message.style === CONST.CHAT_MESSAGE_STYLES.OOC) update.style = CONST.CHAT_MESSAGE_STYLES.IC;
  message.updateSource(update);
  if (data) {
    data.speaker = speaker;
    if (update.style !== undefined) data.style = update.style;
  }
  freezePortrait(message);
}

/** Register the hooks that keep the bar current. */
export function registerSpeakerBarHooks() {
  // renderChatInput (with its textarea) + renderChatLog + collapseSidebar after 50 ms, as in 0.5.2.
  onChatUiRender(({ hook, input }) => mountSpeakerBar(hook === "renderChatInput" ? input ?? null : undefined));
  Hooks.on("controlToken", () => updateSpeakerBar());
  Hooks.on("canvasReady", () => updateSpeakerBar());
  Hooks.on("updateUser", (user) => {
    if (user.id === game.user.id) updateSpeakerBar();
  });
  Hooks.on("updateActor", () => updateSpeakerBar());
  Hooks.on("updateToken", () => updateSpeakerBar());
}
