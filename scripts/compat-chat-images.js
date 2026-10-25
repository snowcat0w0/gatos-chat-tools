import { MODULE_ID, mod } from "./constants.js";
import { htmlRoot, requireModule } from "./lib.js";
import { shrinkImage, needsShrink } from "./images.js";

/**
 * Compatibility shim for the third-party "chat-images" module (bmarian, v3.3) on Foundry v13.
 *
 * Problems it works around:
 *  1. On v13 chat-images looks for `.chat-controls`, but v13.351 renders `#chat-controls`,
 *     so its upload area (#ci-chat-upload-area) is never created. Its paste handler locks the
 *     chat input + shows a spinner, then bails out without unlocking -> endless "loading".
 *  2. Without the upload area it binds no listeners until the first sidebar collapse/expand,
 *     and binds another copy on every later one.
 *  3. Its init hook sets CONFIG.debug.hooks = true for every client, logging every hook call.
 *  4. It compresses pasted images to 1.5 MB while keeping resolution. A PNG screenshot can't
 *     get there by lowering quality, so it re-encodes the full image ~10 times (~30 s locked).
 *     We re-encode large pastes to WebP once ourselves before chat-images sees them.
 *
 * chat-images' own code is left untouched; everything here is skipped when it is inactive
 * or when the world setting `chatImagesCompat` is off.
 */

const CI_ID = "chat-images";
const AREA_ID = "ci-chat-upload-area";
const SPINNER_ID = "ci-spinner";
const SETTING = "chatImagesCompat";

/** Events we re-dispatch ourselves; the capture listener must let them through. */
const ownEvents = new WeakSet();

function enabled() {
  if (!requireModule(CI_ID)) return false;
  try {
    return game.settings.get(MODULE_ID, SETTING) !== false;
  } catch {
    return true;
  }
}

function sidebarElement() {
  return htmlRoot(ui.sidebar?.element);
}

/** True when chat-images' jQuery paste listener is bound on the sidebar. */
function hasPasteListener(el) {
  const events = globalThis.jQuery?._data?.(el, "events");
  return !!events?.paste?.length;
}

/* ------------------------------------------------------------------ */
/* Upload area + listener binding                                       */
/* ------------------------------------------------------------------ */

/** Ask chat-images to bind its listeners once, via its own collapseSidebar handler. */
function bindChatImagesListeners() {
  const el = sidebarElement();
  if (!el || hasPasteListener(el) || el.querySelector(`#${AREA_ID}`)) return;
  if (!el.querySelector("#chat-message")) return; // sidebar collapsed: input lives elsewhere
  const handlers = (Hooks.events.collapseSidebar ?? []).filter((h) => {
    const src = String(h.fn);
    return src.includes("#chat-message") && src.includes(".element");
  });
  for (const h of handlers) {
    try {
      h.fn(ui.sidebar, false);
    } catch (err) {
      mod.warn("chat-images compat: could not bind listeners", err);
    }
  }
}

/** Create the upload area chat-images expects, right before #chat-controls. */
function ensureUploadArea() {
  const el = sidebarElement();
  if (!el || el.querySelector(`#${AREA_ID}`)) return;
  const controls = el.querySelector("#chat-controls, .chat-controls");
  if (!controls) return;
  const area = document.createElement("div");
  area.id = AREA_ID;
  area.className = "hidden";
  controls.before(area);
}

/** Release a lock left behind by an earlier failed paste. */
function releaseStaleLock() {
  const el = sidebarElement();
  if (!el || busy) return;
  const input = el.querySelector("#chat-message");
  const spinner = el.querySelector(`#${SPINNER_ID}`);
  if (spinner && input?.disabled) {
    input.disabled = false;
    spinner.remove();
  }
}

function patch() {
  if (!enabled()) return;
  bindChatImagesListeners();
  ensureUploadArea();
  releaseStaleLock();
}

/** Run after chat-images' own handler for the same hook. */
function deferredPatch() {
  setTimeout(patch, 0);
}

/* ------------------------------------------------------------------ */
/* Pre-shrinking large pastes                                           */
/* ------------------------------------------------------------------ */

let busy = false;

function hasHtmlImages(data) {
  const html = data.getData?.("text/html");
  return !!html && /<img[\s>]/i.test(html);
}

function showSpinner(input) {
  input.disabled = true;
  const form = input.closest(".chat-form") ?? input.parentElement;
  if (form && !form.querySelector(`#${SPINNER_ID}`)) {
    const s = document.createElement("div");
    s.id = SPINNER_ID;
    form.append(s);
  }
}

function hideSpinner(input) {
  input.disabled = false;
  input.closest(".chat-form")?.querySelector(`#${SPINNER_ID}`)?.remove();
}

function redispatch(input, type, files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const ev = type === "drop"
    ? new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })
    : new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  ownEvents.add(ev);
  input.dispatchEvent(ev);
}

/** Capture-phase handler: runs before chat-images' jQuery handler on the sidebar. */
function onPasteOrDrop(event) {
  if (ownEvents.has(event) || !enabled()) return;
  const input = event.target?.closest?.("#chat-message");
  if (!input || !sidebarElement()?.contains(input)) return;
  const data = event.clipboardData ?? event.dataTransfer;
  if (!data || hasHtmlImages(data)) return; // copied from a web page: chat-images links the URL
  const files = [...(data.files ?? [])];
  if (!files.some(needsShrink)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  if (busy) return;
  busy = true;
  showSpinner(input);
  (async () => {
    const out = [];
    for (const f of files) {
      if (!f.type?.startsWith("image/")) continue;
      if (!needsShrink(f)) {
        out.push(f);
        continue;
      }
      try {
        out.push(await shrinkImage(f));
      } catch (err) {
        mod.warn(`chat-images compat: could not shrink ${f.name}, passing it through`, err);
        out.push(f);
      }
    }
    busy = false;
    hideSpinner(input);
    if (out.length) redispatch(input, event.type, out);
  })();
}

/* ------------------------------------------------------------------ */

export function registerChatImagesCompat() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTING, {
      name: "GCT.Settings.ChatImagesCompat.Name",
      hint: "GCT.Settings.ChatImagesCompat.Hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      requiresReload: true,
    });
  });
  Hooks.once("ready", () => {
    if (!enabled()) return;
    if (CONFIG.debug.hooks) {
      CONFIG.debug.hooks = false;
      console.info(`${MODULE_ID} | chat-images compat: turned off CONFIG.debug.hooks (forced on by chat-images)`);
    }
    document.addEventListener("paste", onPasteOrDrop, true);
    document.addEventListener("drop", onPasteOrDrop, true);
    patch();
  });
  Hooks.on("collapseSidebar", deferredPatch);
  Hooks.on("activateChatLog", deferredPatch);
  Hooks.on("renderChatLog", deferredPatch);
  Hooks.on("renderChatInput", deferredPatch);
}
