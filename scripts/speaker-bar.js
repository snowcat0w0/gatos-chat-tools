import { MODULE_ID, L, mod, isNote } from "./constants.js";
import { onChatUiRender, userFlagStore, esc, impl } from "./lib.js";
import { setting } from "./settings.js";
import { matchChitchat, isChitchat } from "./chitchat.js";
import { onPreCreateChatMessage as freezePortrait } from "./portrait.js";

const DEFAULT_IMG = "icons/svg/mystery-man.svg";
const LOCK_FLAG = "lockedSpeaker";
const FAV_FLAG = "favoriteSpeakers";
const FAV_MAX = 24;
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

let favQueue = Promise.resolve();

/**
 * Change the favourites in order: `fn(current list)` returns the new list (or null for no change). Queued so quick
 * clicks (the actor list) each see the previous write instead of overwriting it. Resolves to whether it changed.
 */
function updateFavorites(fn) {
  const run = favQueue.then(async () => {
    const next = fn(getFavorites());
    if (!next) return false;
    await favStore.set(next);
    updateSpeakerBar();
    return true;
  });
  favQueue = run.catch((err) => mod.error("favourite update failed", err));
  return run;
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

/** A favourite that speaks as a world actor alone (no token): added from the actor list or by dropping an actor. */
const actorSnapshot = (actor) => ({ sceneId: null, tokenId: null, actorId: actor.id, alias: actor.name });

/**
 * The image a speaker will be shown with: the bar portrait, the chips and the actor list all go through the
 * `gctSpeakerBarResolve` hook, so a listener (gatos-visual-novel: the current expression's face) changes them all
 * alike and they match the portrait the next chat card gets.
 */
function speakerImage(info) {
  Hooks.callAll("gctSpeakerBarResolve", info);
  return info.img || DEFAULT_IMG;
}

/** The speaker info of a stored favourite (same shape as resolveCurrentSpeaker). */
function favoriteInfo(fav) {
  const { token, actor } = lookup(fav);
  return {
    img: token?.texture?.src ?? actor?.img ?? DEFAULT_IMG,
    name: fav.alias ?? token?.name ?? actor?.name ?? "?",
    locked: false,
    stale: !token && !actor,
    actor,
    token,
    sceneId: token ? fav.sceneId ?? null : null,
  };
}

/** Actors this user may speak as from the list: every world actor for a GM, owned actors for a player. */
const speakableActors = () =>
  game.actors.contents.filter((a) => game.user.isGM || a.isOwner).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

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

/** Add a snapshot to the favourites (warns and resolves false on a duplicate or a full list). */
function addFavorite(snap) {
  return updateFavorites((favs) => {
    if (favs.some((f) => sameSpeaker(f, snap))) {
      ui.notifications.warn(L("SpeakerBar.FavDuplicate"));
      return null;
    }
    if (favs.length >= FAV_MAX) {
      ui.notifications.warn(L("SpeakerBar.FavFull", { max: FAV_MAX }));
      return null;
    }
    return [...favs, snap];
  });
}

async function addCurrentToFavorites() {
  const info = resolveCurrentSpeaker();
  if (!info.actor && !info.token) return ui.notifications.warn(L("SpeakerBar.NothingToLock"));
  return addFavorite(snapshot(info));
}

/** Take one favourite out by snapshot (indexes can shift while a write is queued). */
function removeFavorite(snap) {
  return updateFavorites((favs) => (favs.some((f) => sameSpeaker(f, snap)) ? favs.filter((f) => !sameSpeaker(f, snap)) : null));
}

/**
 * A chip was clicked: speak as that favourite, then tell other modules (gatos-visual-novel puts the stand up).
 * Hook `gctSpeakerChipActivated({actor, token, sceneId, alias})`, on the clicking client only.
 */
async function activateFavorite(fav) {
  await setLockedSpeaker(fav);
  const { token, actor } = lookup(fav);
  if (!token && !actor) return;
  Hooks.callAll("gctSpeakerChipActivated", { actor, token, sceneId: token ? fav.sceneId ?? null : null, alias: fav.alias ?? token?.name ?? actor?.name ?? null });
}

/** An actor dropped on the speaker bar (from the sidebar) becomes a favourite. */
async function onDropActor(ev) {
  const data = impl.TextEditor().getDragEventData(ev);
  if (data?.type !== "Actor" || !data.uuid) return;
  ev.preventDefault();
  const actor = await fromUuid(data.uuid).catch(() => null);
  if (!actor || actor.pack) return ui.notifications.warn(L("SpeakerBar.WorldActorsOnly"));
  if (!game.user.isGM && !actor.isOwner) return ui.notifications.warn(L("SpeakerBar.NotOwner", { name: actor.name }));
  await addFavorite(actorSnapshot(actor));
}

/* -------------------------------------------- */
/*  Actor list (the + button)                   */
/* -------------------------------------------- */

let picker = null;
let pickerCleanup = null;

function closePicker() {
  pickerCleanup?.();
  pickerCleanup = null;
  picker?.remove();
  picker = null;
}

/** Fill the list for the search text; a row is ticked when that actor is already a favourite. */
function renderPickerList() {
  if (!picker) return;
  const q = picker.querySelector(".gct-sp-search").value.trim().toLocaleLowerCase();
  const favs = getFavorites();
  const rows = [];
  const current = resolveCurrentSpeaker();
  // The current speaker first (a token keeps its token, as the old + button did), unless it is a favourite already.
  if ((current.actor || current.token) && !favs.some((f) => sameSpeaker(f, snapshot(current)))) {
    if (!q || current.name.toLocaleLowerCase().includes(q)) {
      rows.push(`<button type="button" class="gct-sp-item current" data-current="1">
        <img src="${esc(speakerImage({ ...current }))}" alt=""><span class="gct-sp-name">${esc(current.name)}</span>
        <span class="gct-sp-tag">${esc(L("SpeakerBar.PickerCurrent"))}</span></button>`);
    }
  }
  for (const actor of speakableActors()) {
    if (q && !actor.name.toLocaleLowerCase().includes(q)) continue;
    const added = favs.some((f) => sameSpeaker(f, actorSnapshot(actor)));
    const img = speakerImage({ img: actor.img ?? DEFAULT_IMG, name: actor.name, locked: false, actor, token: null, sceneId: null });
    rows.push(`<button type="button" class="gct-sp-item${added ? " added" : ""}" data-actor-id="${actor.id}">
      <img src="${esc(img)}" alt=""><span class="gct-sp-name">${esc(actor.name)}</span>
      <i class="fa-solid ${added ? "fa-check" : "fa-plus"} gct-sp-mark"></i></button>`);
  }
  picker.querySelector(".gct-sp-list").innerHTML = rows.join("") || `<p class="gct-sp-empty">${esc(L("SpeakerBar.PickerEmpty"))}</p>`;
}

/** Open the actor list above the + button (or close it). A row adds that actor; a ticked row takes it out again. */
function openPicker(anchor) {
  if (picker) return closePicker();
  picker = document.createElement("div");
  picker.className = "gct-sp-menu";
  picker.innerHTML = `<div class="gct-sp-head">${esc(L("SpeakerBar.PickerTitle"))}</div>
    <input type="search" class="gct-sp-search" placeholder="${esc(L("SpeakerBar.PickerSearch"))}">
    <div class="gct-sp-list"></div>
    <p class="gct-sp-hint">${esc(L("SpeakerBar.PickerHint"))}</p>`;
  picker.querySelector(".gct-sp-search").addEventListener("input", () => renderPickerList());
  picker.addEventListener("click", async (ev) => {
    const item = ev.target.closest(".gct-sp-item");
    if (!item) return;
    if (item.dataset.current) await addCurrentToFavorites();
    else {
      const actor = game.actors.get(item.dataset.actorId);
      if (!actor) return;
      // Decided from the row's own tick, so a second quick click on the same row undoes the first.
      if (item.classList.contains("added")) await removeFavorite(actorSnapshot(actor));
      else {
        item.classList.add("added");
        await addFavorite(actorSnapshot(actor));
      }
    }
    renderPickerList();
  });
  document.body.append(picker);
  renderPickerList();

  // Above the button, kept inside the viewport.
  const rect = anchor.getBoundingClientRect();
  picker.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - picker.offsetWidth - 8))}px`;
  picker.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
  picker.querySelector(".gct-sp-search").focus();

  // The + button is re-created whenever the chips re-render, so it is matched by class rather than by element.
  const onDown = (ev) => {
    if (picker?.contains(ev.target) || ev.target.closest?.(".gct-sb-add")) return;
    closePicker();
  };
  // Escape closes only the list (Foundry's own Escape would open the main menu).
  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closePicker();
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  pickerCleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
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
  // `gctSpeakerBarPortraitClick(info, portrait, event)`: a listener returning false takes the click over
  // (gatos-visual-novel: the expression menu); otherwise the speaker's sheet opens.
  bar.querySelector(".gct-sb-portrait").addEventListener("click", (ev) => {
    const info = resolveCurrentSpeaker();
    if (Hooks.call("gctSpeakerBarPortraitClick", info, ev.currentTarget, ev) === false) return;
    info.actor?.sheet?.render(true);
  });
  const favStrip = bar.querySelector(".gct-sb-favs");
  favStrip.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.closest(".gct-sb-reset")) return void setLockedSpeaker(null);
    const add = t.closest(".gct-sb-add");
    if (add) return void openPicker(add);
    const chip = t.closest(".gct-sb-chip");
    if (!chip) return;
    const fav = getFavorites()[Number(chip.dataset.index)];
    if (fav) void activateFavorite(fav);
  });
  // Right-click takes a chip out (no small × to hit by accident while picking a speaker).
  favStrip.addEventListener("contextmenu", (ev) => {
    const chip = ev.target.closest(".gct-sb-chip");
    if (!chip) return;
    ev.preventDefault();
    ev.stopPropagation();
    const fav = getFavorites()[Number(chip.dataset.index)];
    if (fav) void removeFavorite(fav);
  });
  // Actors dragged from the sidebar onto the bar become favourites.
  bar.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    bar.classList.add("gct-sb-drop");
  });
  bar.addEventListener("dragleave", (ev) => {
    if (!bar.contains(ev.relatedTarget)) bar.classList.remove("gct-sb-drop");
  });
  bar.addEventListener("drop", (ev) => {
    bar.classList.remove("gct-sb-drop");
    void onDropActor(ev);
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
    const info = favoriteInfo(fav);
    const name = info.name;
    const chip = document.createElement("a");
    chip.className = `gct-sb-chip${mode === "name" ? " mode-name" : ""}${sameSpeaker(fav, locked) ? " active" : ""}${info.stale ? " stale" : ""}`;
    chip.dataset.index = String(index);
    chip.dataset.tooltip = L("SpeakerBar.ChipTooltip", { name });
    if (mode === "name") {
      const label = document.createElement("span");
      label.className = "gct-sb-chip-label";
      label.textContent = name;
      chip.append(label);
    } else {
      const im = document.createElement("img");
      im.src = info.stale ? DEFAULT_IMG : speakerImage(info);
      im.alt = name;
      chip.append(im);
    }
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
    bar.querySelector(".gct-sb-portrait").src = speakerImage(info);
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
  // Foundry (v13/v14) shows the author's name for OOC messages regardless of speaker, so a locked speaker speaks in character.
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
