import { MODULE_ID, L, mod } from "./constants.js";
import { esc, formDialog, gmUsers, htmlRoot, onChatUiRender, userFlagStore } from "./lib.js";
import { addToolsButton } from "./chat-controls.js";
import { matchChitchat } from "./chitchat.js";

const FLAG = "whisperTarget";
const BAR_CLASS = "gct-whisper-bar";
const PENDING_KEY = "whisperPending";

/*
 * Whisper targets chosen from the chat controls. The target is a per-user setting (user flag) that
 * applies to text typed into the chat input (normal messages and chitchat); slash commands such as
 * /w or /r keep their own behaviour. Recipients are resolved when the message is sent, so "token
 * owners" means the players owning the token at that moment.
 *
 * target = { mode: "public" | "gm" | "users" | "token" | "targeted" | "controlled",
 *            users: string[], sceneId, tokenId, tokenName, oneShot: boolean }
 */

const EMPTY = { mode: "public", users: [], sceneId: null, tokenId: null, tokenName: null, oneShot: false };

/** Per-user whisper target (gatos-lib user flag store; get() merges the stored object over EMPTY). */
const targetStore = userFlagStore(mod, FLAG, { default: EMPTY });

export function getWhisperTarget() {
  return targetStore.get();
}

/** Store a target. Every key is written so a previous mode's leftovers never survive the flag merge. */
export async function setWhisperTarget(target = {}) {
  const t = { ...EMPTY, ...target };
  t.users = [...new Set(t.users ?? [])];
  await targetStore.set(t);
  updateWhisperBar();
  return t;
}

export const clearWhisperTarget = () => setWhisperTarget({ ...EMPTY, oneShot: getWhisperTarget().oneShot });

/** Players (non-GM users) who own the token's actor right now. */
export function tokenOwners(tokenDoc) {
  const actor = tokenDoc?.actor;
  if (!actor) return [];
  return game.users.filter((u) => !u.isGM && actor.testUserPermission(u, "OWNER"));
}

function tokensForTarget(t) {
  switch (t.mode) {
    case "token": {
      const doc = game.scenes.get(t.sceneId)?.tokens.get(t.tokenId);
      return doc ? [doc] : [];
    }
    case "targeted":
      return [...game.user.targets].map((tk) => tk.document);
    case "controlled":
      return (canvas?.tokens?.controlled ?? []).map((tk) => tk.document);
    default:
      return [];
  }
}

/**
 * The users a target whispers to, computed now. GMs are always included (players whispering to each
 * other must be visible to the GM). Returns null for "public".
 * @returns {{ids: string[], players: User[], tokens: TokenDocument[], warning: string|null}|null}
 */
export function resolveRecipients(target = getWhisperTarget()) {
  if (!target || target.mode === "public") return null;
  let players = [];
  let tokens = [];
  let warning = null;
  switch (target.mode) {
    case "gm":
      break;
    case "users":
      players = (target.users ?? []).map((id) => game.users.get(id)).filter((u) => u && u.id !== game.user.id);
      if (!players.length && !(target.users ?? []).some((id) => game.users.get(id)?.isGM)) warning = L("Whisper.NoUsers");
      break;
    default:
      tokens = tokensForTarget(target);
      if (!tokens.length) warning = L(target.mode === "token" ? "Whisper.TokenGone" : target.mode === "targeted" ? "Whisper.NoTargets" : "Whisper.NoControlled");
      else {
        players = [...new Set(tokens.flatMap((tk) => tokenOwners(tk)))];
        if (!players.length) warning = L("Whisper.NoOwners", { names: tokens.map((tk) => tk.name).join(", ") });
      }
  }
  const ids = [...new Set([...players.map((u) => u.id), ...(target.users ?? []).filter((id) => game.users.get(id)?.isGM), ...gmUsers().map((u) => u.id)])];
  return { ids, players, tokens, warning };
}

/** Short label for the bar, the button tooltip and the message card. */
export function describeTarget(t = getWhisperTarget()) {
  switch (t.mode) {
    case "gm":
      return L("Whisper.ToGM");
    case "users": {
      const names = (t.users ?? []).map((id) => game.users.get(id)?.name).filter(Boolean);
      return L("Whisper.ToUsers", { names: names.join(", ") || "—" });
    }
    case "token":
      return L("Whisper.ToToken", { name: t.tokenName ?? "?" });
    case "targeted":
      return L("Whisper.ToTargeted");
    case "controlled":
      return L("Whisper.ToControlled");
    default:
      return L("Whisper.Public");
  }
}

/** Live preview of who would receive the message, for the bar. */
function recipientPreview(t) {
  const r = resolveRecipients(t);
  if (!r) return "";
  const names = r.players.map((u) => u.name);
  return names.length ? names.join(", ") : L("Whisper.GMOnly");
}

/* -------------------------------------------- */
/*  Message hooks                               */
/* -------------------------------------------- */

/** A target used for exactly one processMessage call (the token menu), without touching the sticky one. */
let override = null;

/**
 * Send `text` through the normal chat pipeline (chitchat triggers, ruby, speaker lock …) as a whisper
 * to `target`, leaving the user's chosen whisper target unchanged.
 */
export async function sendWithTarget(target, text, options = {}) {
  override = { ...EMPTY, ...target };
  try {
    // The chatMessage hook runs synchronously at the start of processMessage, so the override is seen there.
    const pending = ui.chat.processMessage(text, options);
    override = null;
    return await pending;
  } finally {
    override = null;
  }
}

/**
 * chatMessage: apply the chosen target to text typed into the chat input. Must run before
 * chitchat's handler (which builds its message from `chatData`).
 */
export function onChatMessageWhisper(chatLog, text, chatData) {
  const fromOverride = !!override;
  const t = override ?? getWhisperTarget();
  if (t.mode === "public") return;
  // v14 chat input is a ProseMirror editor: the text arrives as HTML ("<p>/w …</p>").
  const trimmed = String(text ?? "").replace(/^(?:\s|<[^>]*>)*/, "").trim();
  if (trimmed.startsWith("/") && !matchChitchat(trimmed)) return; // /w, /r, /gm … keep core behaviour
  const r = resolveRecipients(t);
  if (!r) return;
  if (r.warning) ui.notifications.warn(r.warning);
  chatData.whisper = [...r.ids];
  chatData.flags = foundry.utils.mergeObject(chatData.flags ?? {}, {
    [MODULE_ID]: {
      whisperTo: {
        mode: t.mode,
        label: describeTarget(t),
        ...(t.mode === "token" ? { sceneId: t.sceneId, tokenId: t.tokenId } : {}),
      },
      // Transient: v14 processMessage creates with a `messageMode` option whose applyMode() (in _preCreate) resets
      // `whisper` ("public"/"self") or sets `blind`. preCreateChatMessage re-applies these ids and drops the key.
      [PENDING_KEY]: [...r.ids],
    },
  });
  if (t.oneShot && !fromOverride) setTimeout(() => clearWhisperTarget(), 0);
}

/** preCreateChatMessage (runs after ChatMessage#_preCreate): restore the chosen recipients over the core message mode. */
function restorePendingWhisper(message) {
  const ids = message.flags?.[MODULE_ID]?.[PENDING_KEY];
  if (!Array.isArray(ids)) return;
  message.updateSource({ whisper: [...ids], blind: false, flags: { [MODULE_ID]: { [PENDING_KEY]: _del } } });
}

/**
 * preCreateChatMessage: a player's whisper to another player always includes every GM, whichever
 * way it was sent (this tool, core /w, macros). Whispers only to oneself (self rolls) are left alone.
 */
export function onPreCreateChatMessageWhisperGM(message, data, options, userId) {
  if (userId !== game.user.id) return;
  restorePendingWhisper(message);
  // Whispered documents reach every client (hidden in the log), but Foundry shows the chat bubble on all
  // of them without a visibility check, which would leak the text over the token. No bubbles for whispers.
  if (message.whisper?.length && options) options.chatBubble = false;
  if (game.user.isGM) return;
  const whisper = [...(message.whisper ?? [])];
  if (!whisper.length) return;
  const toOtherPlayer = whisper.some((id) => id !== game.user.id && !game.users.get(id)?.isGM);
  if (!toOtherPlayer) return;
  const merged = [...new Set([...whisper, ...gmUsers().map((u) => u.id)])];
  if (merged.length !== whisper.length) message.updateSource({ whisper: merged });
}

/** renderChatMessageHTML: show which target a whisper was sent to (e.g. "Goblin's owners"). */
export function onRenderChatMessageWhisper(message, html) {
  const li = htmlRoot(html);
  const info = message?.flags?.[MODULE_ID]?.whisperTo;
  if (!li || !info?.label || !message.whisper?.length) return;
  const to = li.querySelector(".whisper-to");
  if (!to || to.querySelector(".gct-whisper-label")) return;
  const span = document.createElement("span");
  span.className = "gct-whisper-label";
  span.textContent = ` (${info.label})`;
  to.append(span);
}

/* -------------------------------------------- */
/*  Dialog                                      */
/* -------------------------------------------- */

/** The scene to list tokens from: the one on the canvas, else the viewed / active scene. */
const listScene = () => canvas?.scene ?? game.scenes.viewed ?? game.scenes.active ?? null;

function sceneTokens() {
  const scene = listScene();
  if (!scene) return [];
  return scene.tokens.contents
    .filter((tk) => tk.actor)
    .map((tk) => ({ doc: tk, owners: tokenOwners(tk) }))
    .sort((a, b) => b.owners.length - a.owners.length || a.doc.name.localeCompare(b.doc.name, game.i18n.lang));
}

export async function openWhisperDialog() {
  const t = getWhisperTarget();
  const users = game.users.filter((u) => u.id !== game.user.id).sort((a, b) => Number(b.isGM) - Number(a.isGM) || a.name.localeCompare(b.name, game.i18n.lang));
  const tokens = sceneTokens();
  const radio = (mode, label, extra = "") =>
    `<label class="gct-wt-mode"><input type="radio" name="mode" value="${mode}"${t.mode === mode ? " checked" : ""}> <strong>${esc(label)}</strong>${extra}</label>`;
  const userRows = users
    .map((u) => `<label class="gct-check-row"><input type="checkbox" name="user" value="${u.id}"${t.users.includes(u.id) ? " checked" : ""}> <span class="gct-wt-dot${u.active ? " on" : ""}"></span>${esc(u.name)}${u.isGM ? ` <em class="gct-dim">GM</em>` : ""}</label>`)
    .join("");
  const tokenOptions = tokens
    .map(({ doc, owners }) => `<option value="${doc.id}"${t.mode === "token" && t.tokenId === doc.id && t.sceneId === doc.parent?.id ? " selected" : ""}>${esc(doc.name)} — ${esc(owners.length ? owners.map((u) => u.name).join(", ") : L("Whisper.NoOwnerShort"))}</option>`)
    .join("");
  const content = `<div class="gct-whisper-form">
    ${radio("public", L("Whisper.Public"))}
    ${radio("gm", L("Whisper.ToGM"))}
    ${radio("users", L("Whisper.PickUsers"))}
    <div class="gct-wt-sub" data-for="users">${userRows || `<p class="hint">${esc(L("Whisper.NoOtherUsers"))}</p>`}</div>
    ${radio("token", L("Whisper.PickToken"))}
    <div class="gct-wt-sub" data-for="token">${tokens.length ? `<select name="tokenId">${tokenOptions}</select>` : `<p class="hint">${esc(L("Whisper.NoSceneTokens"))}</p>`}</div>
    ${radio("targeted", L("Whisper.ToTargeted"), ` <span class="hint">${esc(L("Whisper.AtSendTime"))}</span>`)}
    ${radio("controlled", L("Whisper.ToControlled"), ` <span class="hint">${esc(L("Whisper.AtSendTime"))}</span>`)}
    <hr>
    <label class="gct-check-row"><input type="checkbox" name="oneShot"${t.oneShot ? " checked" : ""}> ${esc(L("Whisper.OneShot"))}</label>
    <p class="hint">${esc(L("Whisper.Hint"))}</p>
  </div>`;

  const result = await formDialog({
    title: L("Whisper.Title"),
    icon: "fa-solid fa-user-secret",
    classes: ["gct-whisper-dialog"],
    width: 440,
    content,
    render: (event, dialog) => {
      const form = dialog.element.querySelector("form") ?? dialog.element;
      const sync = () => {
        const mode = form.querySelector("input[name=mode]:checked")?.value;
        form.querySelectorAll(".gct-wt-sub").forEach((el) => el.classList.toggle("active", el.dataset.for === mode));
      };
      // Touching a sub-control selects its mode.
      form.querySelectorAll(".gct-wt-sub").forEach((sub) =>
        sub.addEventListener("change", () => {
          const r = form.querySelector(`input[name=mode][value=${sub.dataset.for}]`);
          if (r) r.checked = true;
          sync();
        })
      );
      form.addEventListener("change", sync);
      sync();
    },
    ok: {
      action: "apply",
      label: L("Whisper.Apply"),
      icon: "fa-solid fa-check",
      read: (button) => {
        const f = button.form;
        const mode = f.querySelector("input[name=mode]:checked")?.value ?? "public";
        const tokenId = f.elements.tokenId?.value ?? null;
        const doc = tokenId ? listScene()?.tokens.get(tokenId) : null;
        return {
          mode,
          users: [...f.querySelectorAll("input[name=user]:checked")].map((i) => i.value),
          sceneId: mode === "token" ? doc?.parent?.id ?? null : null,
          tokenId: mode === "token" ? doc?.id ?? null : null,
          tokenName: mode === "token" ? doc?.name ?? null : null,
          oneShot: !!f.elements.oneShot?.checked,
        };
      },
    },
    cancel: { label: L("Cancel") },
  });
  if (!result) return null;
  if (result.mode === "users" && !result.users.length) result.mode = "public";
  if (result.mode === "token" && !result.tokenId) result.mode = "public";
  return setWhisperTarget(result);
}

/* -------------------------------------------- */
/*  Chat input UI                               */
/* -------------------------------------------- */

/**
 * The paper-plane button in the chat controls (click: choose target, right-click: back to public). First on the
 * module's row (chat-controls.js). Not fa-user-secret: core's "GM" message mode above it uses that icon.
 */
export function injectWhisperButton() {
  const btn = addToolsButton({
    cls: "gct-whisper-btn",
    icon: "fa-solid fa-paper-plane",
    onClick: () => openWhisperDialog(),
    onContextMenu: () => clearWhisperTarget(),
    position: "prepend",
  });
  if (!btn) return;
  updateWhisperBar();
}

/** Show / refresh the "whisper → …" bar right above the chat textarea. */
export function updateWhisperBar() {
  const t = getWhisperTarget();
  const active = t.mode !== "public";
  const btn = document.querySelector("#chat-controls .gct-whisper-btn");
  if (btn) {
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
    const tip = active ? `${L("Whisper.Title")}: ${describeTarget(t)}` : L("Whisper.ButtonTooltip");
    btn.setAttribute("aria-label", tip);
    btn.dataset.tooltip = tip;
  }
  const textarea = document.getElementById("chat-message");
  let bar = document.querySelector(`.${BAR_CLASS}`);
  if (!active || !textarea) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = BAR_CLASS;
    bar.innerHTML = `<i class="fa-solid fa-paper-plane"></i><a class="gct-wb-label"></a><span class="gct-wb-who"></span><a class="gct-wb-clear"><i class="fa-solid fa-xmark"></i></a>`;
    bar.querySelector(".gct-wb-label").addEventListener("click", () => openWhisperDialog());
    bar.querySelector(".gct-wb-clear").addEventListener("click", () => clearWhisperTarget());
    bar.querySelector(".gct-wb-clear").dataset.tooltip = L("Whisper.Clear");
  }
  if (bar.nextElementSibling !== textarea) textarea.before(bar);
  bar.querySelector(".gct-wb-label").textContent = `${describeTarget(t)}${t.oneShot ? ` · ${L("Whisper.OnceTag")}` : ""}`;
  const who = recipientPreview(t);
  bar.querySelector(".gct-wb-who").textContent = who ? `→ ${who}` : "";
  bar.classList.toggle("gct-wb-warn", !!resolveRecipients(t)?.warning);
}

export function registerWhisperHooks() {
  onChatUiRender(() => injectWhisperButton(), { deferCollapse: false }); // renderChatInput + renderChatLog
  Hooks.on("gctSpeakerBarMounted", () => updateWhisperBar());
  targetStore.watch(() => updateWhisperBar()); // the user's flag changed (any window, any client)
  // Live recipient preview for the "at send time" modes and ownership changes.
  for (const hook of ["targetToken", "controlToken", "updateActor", "updateToken", "deleteToken", "canvasReady"]) {
    Hooks.on(hook, () => {
      if (getWhisperTarget().mode !== "public") updateWhisperBar();
    });
  }
  Hooks.on("renderChatMessageHTML", onRenderChatMessageWhisper);
  Hooks.on("preCreateChatMessage", onPreCreateChatMessageWhisperGM);
}
