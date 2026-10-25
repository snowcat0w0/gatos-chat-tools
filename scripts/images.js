import { MODULE_ID, mod } from "./constants.js";
import { addChatControl, ensureDataDir, htmlRoot, onChatUiRender, requireModule } from "./lib.js";

/**
 * Native image attachments for the chat input (absorbs what the "chat-images" module did):
 *  - paste / drop image files (or images copied from a web page) into the chat input
 *  - an image button in the chat controls
 *  - upload to a configurable Data folder (default "uploaded-chat-images", same as chat-images)
 *  - a preview tray with remove buttons; uploads run in the background, typing stays possible
 *  - Enter with only images sends an image message; with text, the images go above the text
 *  - `!ci|https://…/x.png!` in a message becomes an embedded image
 *  - click an image in chat to open a shareable popout
 * Message markup stays chat-images compatible (.ci-message / .ci-message-image / .ci-notes), so
 * messages made by either module look and behave the same.
 *
 * Disabled while the chat-images module itself is active (compat-chat-images.js covers that case).
 */

const CI_ID = "chat-images";
const TRAY_CLASS = "gct-image-tray";
const BUTTON_CLASS = "gct-image-upload";
const IMAGE_EXT = /\.(?:gif|png|jpe?g|webp|avif|svg|bmp|tiff?)(?:[?#].*)?$/i;
const CI_SYNTAX = /!\s*ci\s*\|\s*(.+?)\s*!/gi;
const SKIP_SHRINK = new Set(["image/gif", "image/svg+xml"]);
export const LIMIT_BYTES = 1.5 * 1024 * 1024;
const TARGET_BYTES = 1.4 * 1024 * 1024;
const ARM_MS = 10000;

/** @type {{id:string, name:string, preview:string, src:string|null, status:"uploading"|"ready"|"error", promise:Promise}[]} */
let pending = [];
let armedAt = 0;
const ownEvents = new WeakSet();

/** Localize under GCT.Images (named `Li` so the static smoke tool does not read it as the module prefix). */
const Li = (key, data) => (data ? game.i18n.format(`GCT.Images.${key}`, data) : game.i18n.localize(`GCT.Images.${key}`));

/* ------------------------------------------------------------------ */
/* Shrinking (shared with compat-chat-images.js)                        */
/* ------------------------------------------------------------------ */

export function needsShrink(file) {
  return file.type?.startsWith("image/") && !SKIP_SHRINK.has(file.type) && file.size > LIMIT_BYTES;
}

async function encode(bitmap, width, height, quality) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type: "image/webp", quality });
}

/** Re-encode to WebP at full resolution; scale down only if it is still too big. */
export async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    let { width, height } = bitmap;
    let blob = await encode(bitmap, width, height, 0.9);
    if (blob.size > TARGET_BYTES) blob = await encode(bitmap, width, height, 0.8);
    for (let i = 0; i < 4 && blob.size > TARGET_BYTES; i++) {
      const scale = Math.max(0.5, Math.sqrt(TARGET_BYTES / blob.size) * 0.95);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      blob = await encode(bitmap, width, height, 0.8);
    }
    const base = (file.name || "image").replace(/\.[^.]+$/, "") || "image";
    return new File([blob], `${base}.webp`, { type: "image/webp", lastModified: Date.now() });
  } finally {
    bitmap.close?.();
  }
}

/* ------------------------------------------------------------------ */
/* State helpers                                                        */
/* ------------------------------------------------------------------ */

function chatImagesActive() {
  return !!requireModule(CI_ID);
}

export function imagesActive() {
  if (chatImagesActive()) return false;
  try {
    return game.settings.get(MODULE_ID, "imageAttach") !== false;
  } catch {
    return false;
  }
}

function canUpload() {
  return game.user.isGM || game.user.can("FILES_UPLOAD");
}

/** The chat input: a <prose-mirror> element in v14 (its `focus()` focuses the editor view). */
function chatInput() {
  return document.getElementById("chat-message");
}

/** Does the chat input hold no text and no inline content? Its `value` is the editor's serialized HTML ("" when empty). */
function inputIsEmpty(input) {
  const html = String(input?.value ?? "");
  if (/<(?:img|video|iframe|hr)\b/i.test(html)) return false;
  return !html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function imageHtml(items) {
  const imgs = items.map((i) => `<div class="ci-message-image"><img src="${escapeAttr(i.src)}" alt="${escapeAttr(i.name)}"></div>`);
  return `<div class="ci-message">${imgs.join("")}</div>`;
}

/* ------------------------------------------------------------------ */
/* Upload                                                               */
/* ------------------------------------------------------------------ */

function uploadFolder() {
  const raw = String(game.settings.get(MODULE_ID, "imageUploadFolder") ?? "").trim();
  return (raw || "uploaded-chat-images").replace(/\\/g, "/").replace(/\s+/g, "-").replace(/^\/+|\/+$/g, "");
}


const EXT_BY_TYPE = { "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/svg+xml": ".svg", "image/avif": ".avif", "image/bmp": ".bmp" };

/**
 * gatos-lib ensureDataDir creates the folder level by level when missing (remembered per session). It is
 * best-effort here, as in 0.5.2: browsing/creating folders needs FILES_BROWSE, which a player with only
 * FILES_UPLOAD lacks, so the upload itself must still run (and reports its own failure).
 */
async function uploadFile(file, id) {
  const folder = uploadFolder();
  await ensureDataDir(folder).catch(() => {});
  const ext = EXT_BY_TYPE[file.type] ?? (file.name?.match(/\.[a-z0-9]+$/i)?.[0] ?? ".png");
  const named = new File([file], `${id}${ext}`, { type: file.type });
  const FP = foundry.applications.apps.FilePicker.implementation;
  const res = await FP.upload("data", folder, named, {}, { notify: false });
  if (!res?.path) throw new Error(res?.message || "upload failed");
  return res.path;
}

/* ------------------------------------------------------------------ */
/* Tray                                                                 */
/* ------------------------------------------------------------------ */

function trayElement() {
  const input = chatInput();
  if (!input) return null;
  let tray = document.querySelector(`.${TRAY_CLASS}`);
  if (!tray) {
    tray = document.createElement("div");
    tray.className = TRAY_CLASS;
    tray.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-remove]");
      if (btn) removeItem(btn.dataset.remove);
    });
  }
  // Keep it just above the input (Foundry moves the input into the notification area when the sidebar collapses).
  const anchor = input.previousElementSibling?.classList.contains("gct-speaker-bar") ? input.previousElementSibling : input;
  if (tray.nextElementSibling !== anchor) anchor.before(tray);
  return tray;
}

function renderTray() {
  const tray = trayElement();
  if (!tray) return;
  tray.classList.toggle("empty", !pending.length);
  tray.replaceChildren(
    ...pending.map((item) => {
      const el = document.createElement("div");
      el.className = `gct-image-item ${item.status}`;
      el.dataset.id = item.id;
      el.innerHTML = `<img src="${escapeAttr(item.preview || item.src)}" alt="${escapeAttr(item.name)}">`
        + (item.status === "uploading" ? `<i class="fa-solid fa-spinner fa-spin gct-image-busy"></i>` : "")
        + (item.status === "error" ? `<i class="fa-solid fa-triangle-exclamation gct-image-busy" data-tooltip="${escapeAttr(Li("UploadFailed", { name: item.name }))}"></i>` : "")
        + `<button type="button" class="gct-image-remove" data-remove="${item.id}" aria-label="${escapeAttr(Li("Remove"))}"><i class="fa-solid fa-xmark"></i></button>`;
      return el;
    }),
  );
}

function removeItem(id) {
  const item = pending.find((i) => i.id === id);
  if (item?.preview) URL.revokeObjectURL(item.preview);
  pending = pending.filter((i) => i.id !== id);
  renderTray();
  chatInput()?.focus();
}

function clearTray() {
  for (const i of pending) if (i.preview) URL.revokeObjectURL(i.preview);
  pending = [];
  renderTray();
}

/** Add image files: shrink if large, upload in the background. */
export function addFiles(files) {
  const images = [...files].filter((f) => f.type?.startsWith("image/"));
  if (!images.length) return;
  if (!canUpload()) {
    ui.notifications.warn(Li("NoPermission"));
    return;
  }
  for (const file of images) {
    const item = { id: foundry.utils.randomID(), name: file.name || "image", preview: URL.createObjectURL(file), src: null, status: "uploading" };
    item.promise = (async () => {
      try {
        const ready = needsShrink(file) ? await shrinkImage(file).catch(() => file) : file;
        item.src = await uploadFile(ready, item.id);
        item.status = "ready";
      } catch (err) {
        mod.warn("image upload failed", err);
        item.status = "error";
        ui.notifications.error(Li("UploadFailed", { name: item.name }));
      }
      renderTray();
    })();
    pending.push(item);
  }
  renderTray();
}

function addUrls(urls) {
  for (const src of urls) {
    pending.push({ id: foundry.utils.randomID(), name: src.split("/").pop()?.split(/[?#]/)[0] || "image", preview: "", src, status: "ready", promise: Promise.resolve() });
  }
  renderTray();
}

/* ------------------------------------------------------------------ */
/* Input events                                                         */
/* ------------------------------------------------------------------ */

/** <img> sources from copied HTML, only when the HTML is nothing but images. */
function htmlImageUrls(data) {
  const html = data.getData?.("text/html");
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (doc.body.textContent.trim()) return [];
  return [...doc.querySelectorAll("img")].map((i) => i.getAttribute("src")).filter((s) => /^https?:\/\//i.test(s ?? ""));
}

function onPasteOrDrop(event) {
  if (!imagesActive() || ownEvents.has(event)) return;
  if (!event.target?.closest?.("#chat-message")) return;
  const data = event.clipboardData ?? event.dataTransfer;
  if (!data) return;
  const files = [...(data.files ?? [])].filter((f) => f.type?.startsWith("image/"));
  if (files.length) {
    event.preventDefault();
    event.stopImmediatePropagation();
    addFiles(files);
    return;
  }
  const urls = htmlImageUrls(data);
  if (urls.length) {
    event.preventDefault();
    event.stopImmediatePropagation();
    addUrls(urls);
  }
}

async function sendImagesOnly(items) {
  const cls = ChatMessage.implementation;
  const speaker = cls.getSpeaker();
  const style = speaker.token || speaker.actor ? CONST.CHAT_MESSAGE_STYLES.IC : CONST.CHAT_MESSAGE_STYLES.OOC;
  clearTray();
  // v14 applies the chat controls' message mode (public / gm / blind / self / ic) to typed messages; do the same here.
  const messageMode = game.settings.get("core", "messageMode");
  await cls.create({ content: imageHtml(items), speaker, style, author: game.user.id }, { chatBubble: false, messageMode });
}

/** Enter in the chat input: wait for uploads, and send image-only messages ourselves. */
function onKeyDown(event) {
  if (!imagesActive() || ownEvents.has(event)) return;
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  const input = event.target?.closest?.("#chat-message");
  if (!input || !pending.length) return;
  const empty = inputIsEmpty(input);
  const waiting = pending.some((i) => i.status === "uploading");
  if (!empty && !waiting) return; // Foundry sends the text; images are attached in preCreateChatMessage

  event.preventDefault();
  event.stopImmediatePropagation();
  // ProseMirror listens on its contenteditable view, not on the <prose-mirror> host.
  const view = event.target.closest?.(".ProseMirror") ?? input.querySelector(".ProseMirror") ?? input;
  (async () => {
    if (waiting) {
      ui.notifications.info(Li("Waiting"));
      await Promise.all(pending.map((i) => i.promise));
    }
    const ready = pending.filter((i) => i.status === "ready");
    if (!ready.length) return;
    if (inputIsEmpty(input)) return sendImagesOnly(ready);
    const again = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true });
    ownEvents.add(again);
    view.dispatchEvent(again);
  })();
}

/* ------------------------------------------------------------------ */
/* Message hooks                                                        */
/* ------------------------------------------------------------------ */

/** chatMessage hook: the user submitted the chat input. Must run before chitchat's handler. */
function onChatMessage() {
  if (imagesActive() && pending.some((i) => i.status === "ready")) armedAt = Date.now();
}

/** preCreateChatMessage: put tray images above the text; expand !ci|url! syntax. */
function onPreCreateChatMessage(message, data, options, userId) {
  if (!imagesActive()) return;
  let content = message.content ?? "";
  let changed = false;

  if (CI_SYNTAX.test(content)) {
    CI_SYNTAX.lastIndex = 0;
    content = content.replace(CI_SYNTAX, (all, url) => (IMAGE_EXT.test(url) ? imageHtml([{ src: url, name: url.split("/").pop() }]) : all));
    changed = true;
  }
  CI_SYNTAX.lastIndex = 0;

  const armed = armedAt && Date.now() - armedAt < ARM_MS && userId === game.user.id;
  if (armed) {
    armedAt = 0;
    const ready = pending.filter((i) => i.status === "ready");
    if (ready.length && !message.rolls?.length) {
      content = `${imageHtml(ready)}<div class="ci-notes">${content}</div>`;
      changed = true;
      options.chatBubble = false;
      pending = pending.filter((i) => !ready.includes(i));
      for (const i of ready) if (i.preview) URL.revokeObjectURL(i.preview);
      setTimeout(renderTray, 0);
    }
  }
  if (changed) message.updateSource({ content });
}

/** Click an image in chat to open a shareable popout. */
function onRenderChatMessageHTML(message, html) {
  if (!imagesActive()) return;
  for (const img of htmlRoot(html).querySelectorAll(".ci-message-image img")) {
    img.addEventListener("click", () => {
      const Popout = foundry.applications.apps.ImagePopout;
      new Popout({ src: img.getAttribute("src"), shareable: true, window: { title: img.alt || message.alias || "" } }).render({ force: true });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Upload button                                                        */
/* ------------------------------------------------------------------ */

function injectUploadButton() {
  if (!imagesActive() || !canUpload() || !game.settings.get(MODULE_ID, "imageUploadButton")) return;
  const controls = document.getElementById("chat-controls");
  if (!controls || controls.querySelector(`.${BUTTON_CLASS}`)) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.hidden = true;
  input.addEventListener("change", () => {
    addFiles(input.files ?? []);
    input.value = "";
    chatInput()?.focus();
  });
  // gatos-lib addChatControl appends the button; the hidden file input follows it as before.
  const btn = addChatControl({ cls: BUTTON_CLASS, icon: "fa-solid fa-images", label: Li("Button"), onClick: () => input.click(), controls });
  btn.dataset.tooltip = Li("Button");
  controls.append(input);
}

function refreshUi() {
  if (!imagesActive()) return;
  injectUploadButton();
  if (pending.length) renderTray();
}

/* ------------------------------------------------------------------ */

export function registerImageSettings() {
  game.settings.register(MODULE_ID, "imageAttach", {
    name: "GCT.Settings.ImageAttach.Name",
    hint: "GCT.Settings.ImageAttach.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true,
  });
  game.settings.register(MODULE_ID, "imageUploadFolder", {
    name: "GCT.Settings.ImageUploadFolder.Name",
    hint: "GCT.Settings.ImageUploadFolder.Hint",
    scope: "world",
    config: true,
    restricted: true,
    type: String,
    default: "uploaded-chat-images",
  });
  game.settings.register(MODULE_ID, "imageUploadButton", {
    name: "GCT.Settings.ImageUploadButton.Name",
    hint: "GCT.Settings.ImageUploadButton.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true,
  });
}

/** Register hooks. Call at module top level, before chitchat's chatMessage hook. */
export function registerImageHooks() {
  Hooks.once("init", registerImageSettings);
  Hooks.on("chatMessage", onChatMessage);
  Hooks.on("preCreateChatMessage", onPreCreateChatMessage);
  Hooks.on("renderChatMessageHTML", onRenderChatMessageHTML);
  onChatUiRender(() => refreshUi(), { defer: true, deferCollapse: 0 }); // all three deferred by a tick, as before
  Hooks.once("ready", () => {
    if (game.user.isGM && chatImagesActive()) {
      ui.notifications.info(game.i18n.localize("GCT.Images.ChatImagesActive"), { permanent: false });
    }
    if (!imagesActive()) return;
    document.addEventListener("paste", onPasteOrDrop, true);
    document.addEventListener("drop", onPasteOrDrop, true);
    document.addEventListener("keydown", onKeyDown, true);
    refreshUi();
  });
}

/** For tests and macros. */
export const imagesApi = {
  addFiles,
  get pending() {
    return pending.map(({ id, name, src, status }) => ({ id, name, src, status }));
  },
  clear: clearTray,
};
