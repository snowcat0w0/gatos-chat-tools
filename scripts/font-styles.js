import { L, mod, isNote } from "./constants.js";
import { addChatControl, esc, settingStore } from "./lib.js";
import { markupToFontStyles, fontStylesToMarkup, fontStyleSpan, sanitizeStyle, styleCss, isValidStyleName } from "./font-styles-markup.js";
import { fontGroups } from "./fonts.js";
import { wrapChatSelection } from "./chat-input.js";

/*
 * Inline font styles: `{@이름 텍스트}` in a chat message shows only that text in a style the GM defined
 * (font family, size, colour, bold, italic). Like ruby, the markup is turned into HTML when the message is
 * created or edited (a span with inline CSS), so every client, the archive and every export render it the same.
 * The style list is a hidden world setting edited by the GM in a settings menu; everybody can use the styles.
 */

/** World setting `fontStyles`: { list: [{ id, name, family, size, color, bold, italic }] }. */
const store = settingStore(mod, "fontStyles");

/** The defined styles (sanitized, in the GM's order). */
export function getFontStyles() {
  const value = store.get();
  const list = Array.isArray(value) ? value : Array.isArray(value?.list) ? value.list : [];
  const seen = new Set();
  return list.map(sanitizeStyle).filter((s) => s && !seen.has(s.name) && seen.add(s.name));
}

/** Convert `{@name text}` markup with the current styles. */
export function convertFontStyles(html) {
  return markupToFontStyles(html, getFontStyles());
}

/* -------------------------------------------- */
/*  Message hooks                               */
/* -------------------------------------------- */

function warnUnknown(unknown) {
  if (unknown?.length) ui.notifications.warn(L("FontStyle.Unknown", { names: unknown.join(", ") }));
}

/** preCreateChatMessage (runs on the sender's client): store the styled spans; warn about unknown names. */
export function onPreCreateChatMessageFontStyle(message, data, options, userId) {
  if (isNote(message)) return; // notes stay plain text
  const content = message._source?.content;
  const { html, unknown } = convertFontStyles(content);
  if (html !== content) message.updateSource({ content: html });
  if (userId === game.user.id) warnUnknown(unknown);
}

/** preUpdateChatMessage: edits that use the markup are converted too. */
export function onPreUpdateChatMessageFontStyle(message, changes, options, userId) {
  if (typeof changes?.content !== "string" || isNote(message)) return;
  const { html, unknown } = convertFontStyles(changes.content);
  if (html !== changes.content) changes.content = html;
  if (userId === game.user.id) warnUnknown(unknown);
}

/* -------------------------------------------- */
/*  Quick menu next to the chat input           */
/* -------------------------------------------- */

let menu = null;
let menuCleanup = null;

function closeFontMenu() {
  menuCleanup?.();
  menuCleanup = null;
  menu?.remove();
  menu = null;
}

/** Wrap the chat input's selection in a style (or insert `{@name }` with the caret inside). */
export function wrapSelectionWith(name) {
  if (!isValidStyleName(name)) return false;
  const result = wrapChatSelection(`{@${name} `, "}");
  if (result === "multiline") ui.notifications.warn(L("FontStyle.OneLine"));
  else if (result === "brace") ui.notifications.warn(L("FontStyle.NoBraces"));
  return result === "ok";
}

/** Open the compact style list above a button (or toggle it closed). */
export function openFontMenu(anchor = document.querySelector("#chat-controls .gct-fs-btn")) {
  if (menu) return closeFontMenu();
  const styles = getFontStyles();
  menu = document.createElement("div");
  menu.className = "gct-fs-menu";
  menu.setAttribute("role", "menu");
  const items = styles
    .map(
      (s) => `<button type="button" class="gct-fs-item" role="menuitem" data-name="${esc(s.name)}">
        <span class="gct-fs-item-name">${esc(s.name)}</span>
        <span class="gct-fs-item-sample" style="${esc(styleCss(s))}">${esc(L("FontStyle.Sample"))}</span>
      </button>`
    )
    .join("");
  const empty = `<p class="gct-fs-empty">${esc(L(game.user.isGM ? "FontStyle.EmptyGM" : "FontStyle.Empty"))}</p>`;
  const manage = game.user.isGM ? `<button type="button" class="gct-fs-manage"><i class="fa-solid fa-gear"></i> ${esc(L("FontStyle.Manage"))}</button>` : "";
  menu.innerHTML = `<div class="gct-fs-menu-head">${esc(L("FontStyle.MenuTitle"))}</div>
    <div class="gct-fs-menu-list">${items || empty}</div>
    <p class="gct-fs-menu-hint">${esc(L("FontStyle.MenuHint"))}</p>${manage}`;
  // Keep the editor focused (and its selection) while picking.
  menu.addEventListener("mousedown", (ev) => ev.preventDefault());
  menu.addEventListener("click", (ev) => {
    const item = ev.target.closest(".gct-fs-item");
    if (item) {
      closeFontMenu();
      wrapSelectionWith(item.dataset.name);
      return;
    }
    if (ev.target.closest(".gct-fs-manage")) {
      closeFontMenu();
      FontStyleConfig.openConfig();
    }
  });
  document.body.append(menu);

  // Above the button, kept inside the viewport.
  const rect = anchor?.getBoundingClientRect?.() ?? { left: window.innerWidth - 320, top: window.innerHeight - 60, right: window.innerWidth - 20 };
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;

  const onDown = (ev) => {
    if (menu?.contains(ev.target) || anchor?.contains?.(ev.target)) return;
    closeFontMenu();
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") closeFontMenu();
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  menuCleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

/** The "A" button in the chat controls (gatos-lib addChatControl; idempotent). */
export function injectFontStyleButton() {
  const btn = addChatControl({
    cls: "gct-fs-btn",
    icon: "fa-solid fa-font",
    label: L("FontStyle.ButtonTooltip"),
    onClick: (ev, button) => openFontMenu(button),
  });
  if (btn && !btn.dataset.gctFsBound) {
    btn.dataset.gctFsBound = "1";
    // Do not take the focus from the chat input on press, so its selection survives the click.
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
  }
}

/** The styles changed (any client): close a stale menu, refresh an open config window. */
export function onFontStylesChanged() {
  closeFontMenu();
}

/* -------------------------------------------- */
/*  Settings menu (GM)                          */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;
const CUSTOM = "__custom";

/** GM editor for the style list: add / edit / delete / reorder, with a live preview per row. */
export class FontStyleConfig extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "gct-font-styles",
    classes: ["gct-font-styles"],
    tag: "div",
    window: { title: "GCT.FontStyle.ConfigTitle", icon: "fa-solid fa-font", resizable: true },
    position: { width: 820, height: 600 },
    actions: {
      addStyle: FontStyleConfig.#onAdd,
      removeStyle: FontStyleConfig.#onRemove,
      moveUp: FontStyleConfig.#onMoveUp,
      moveDown: FontStyleConfig.#onMoveDown,
      saveStyles: FontStyleConfig.#onSave,
      cancel: FontStyleConfig.#onCancel,
    },
  };

  /** Open the window (settings menus construct it themselves; this is for the chat menu and the API). */
  static openConfig() {
    if (!game.user.isGM) return ui.notifications.warn(L("FontStyle.GMOnly"));
    return new this().render({ force: true });
  }

  /** Working copy edited in the window; saved only on "Save". */
  #rows = null;

  async _prepareContext() {
    this.#rows ??= getFontStyles().map((s) => ({ ...s }));
    return { rows: this.#rows, groups: fontGroups() };
  }

  /** Family <select>: inherit, Foundry fonts, Korean web fonts, then free text. */
  #familySelect(family, groups) {
    const known = groups.some((g) => g.fonts.includes(family));
    const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
    const parts = [opt("", L("FontStyle.FamilyInherit"), !family)];
    for (const g of groups) {
      parts.push(`<optgroup label="${esc(L(g.id === "korean" ? "FontStyle.KoreanFonts" : "FontStyle.FoundryFonts"))}">`);
      for (const f of g.fonts) parts.push(opt(f, f, f === family));
      parts.push("</optgroup>");
    }
    parts.push(opt(CUSTOM, L("FontStyle.FamilyCustom"), !!family && !known));
    return `<select name="family">${parts.join("")}</select>`;
  }

  #rowHtml(s, groups) {
    const known = groups.some((g) => g.fonts.includes(s.family));
    const custom = !!s.family && !known;
    return `<li class="gct-fs-row" data-id="${esc(s.id)}">
      <div class="gct-fs-fields">
        <input type="text" name="name" value="${esc(s.name)}" placeholder="${esc(L("FontStyle.NamePlaceholder"))}" maxlength="32" spellcheck="false">
        ${this.#familySelect(s.family, groups)}
        <input type="text" name="customFamily" value="${esc(custom ? s.family : "")}" placeholder="${esc(L("FontStyle.CustomPlaceholder"))}"${custom ? "" : " hidden"}>
        <input type="number" name="size" value="${s.size ?? ""}" min="6" max="96" step="1" placeholder="px" data-tooltip="${esc(L("FontStyle.Size"))}">
        <label class="gct-fs-color" data-tooltip="${esc(L("FontStyle.Color"))}"><input type="checkbox" name="useColor"${s.color ? " checked" : ""}><input type="color" name="color" value="${esc(s.color ?? "#000000")}"></label>
        <label class="gct-fs-toggle" data-tooltip="${esc(L("FontStyle.Bold"))}"><input type="checkbox" name="bold"${s.bold ? " checked" : ""}><i class="fa-solid fa-bold"></i></label>
        <label class="gct-fs-toggle" data-tooltip="${esc(L("FontStyle.Italic"))}"><input type="checkbox" name="italic"${s.italic ? " checked" : ""}><i class="fa-solid fa-italic"></i></label>
        <span class="gct-fs-row-tools">
          <a data-action="moveUp" data-tooltip="${esc(L("FontStyle.MoveUp"))}"><i class="fa-solid fa-arrow-up"></i></a>
          <a data-action="moveDown" data-tooltip="${esc(L("FontStyle.MoveDown"))}"><i class="fa-solid fa-arrow-down"></i></a>
          <a data-action="removeStyle" data-tooltip="${esc(L("Delete"))}"><i class="fa-solid fa-trash"></i></a>
        </span>
      </div>
      <div class="gct-fs-preview"><code class="gct-fs-code"></code><span class="gct-fs-sample"></span></div>
    </li>`;
  }

  async _renderHTML(context) {
    const rows = context.rows.map((s) => this.#rowHtml(s, context.groups)).join("");
    return `<div class="gct-fs-config">
      <p class="hint">${esc(L("FontStyle.ConfigHint"))}</p>
      <ol class="gct-fs-rows">${rows || `<li class="gct-fs-none hint">${esc(L("FontStyle.None"))}</li>`}</ol>
      <footer class="gct-fs-footer">
        <button type="button" data-action="addStyle"><i class="fa-solid fa-plus"></i> ${esc(L("FontStyle.Add"))}</button>
        <span class="gct-fs-spacer"></span>
        <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> ${esc(L("Cancel"))}</button>
        <button type="button" data-action="saveStyles" class="bright"><i class="fa-solid fa-floppy-disk"></i> ${esc(L("Save"))}</button>
      </footer>
    </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    root.querySelectorAll(".gct-fs-row").forEach((row) => this.#updatePreview(row));
    if (root.dataset.gctBound) return;
    root.dataset.gctBound = "1";
    const onEdit = (ev) => {
      const row = ev.target.closest(".gct-fs-row");
      if (!row) return;
      if (ev.target.name === "family") {
        const customInput = row.querySelector("[name=customFamily]");
        customInput.hidden = ev.target.value !== CUSTOM;
        if (!customInput.hidden) customInput.focus();
      }
      if (ev.target.name === "color") row.querySelector("[name=useColor]").checked = true;
      this.#updatePreview(row);
    };
    root.addEventListener("input", onEdit);
    root.addEventListener("change", onEdit);
  }

  /** Read one row of the form into a style object (not sanitized). */
  #readRow(row) {
    const val = (name) => row.querySelector(`[name=${name}]`);
    const familyChoice = val("family").value;
    return {
      id: row.dataset.id,
      name: val("name").value.trim(),
      family: familyChoice === CUSTOM ? val("customFamily").value.trim() : familyChoice,
      size: val("size").value === "" ? null : Number(val("size").value),
      color: val("useColor").checked ? val("color").value : null,
      bold: val("bold").checked,
      italic: val("italic").checked,
    };
  }

  /** Read every row (keeps unsaved edits across add / move / remove re-renders). */
  #syncRows() {
    if (!this.element) return;
    this.#rows = [...this.element.querySelectorAll(".gct-fs-row")].map((row) => this.#readRow(row));
  }

  #updatePreview(row) {
    const s = this.#readRow(row);
    const valid = isValidStyleName(s.name);
    row.classList.toggle("invalid", !valid && !!s.name);
    const sample = row.querySelector(".gct-fs-sample");
    sample.setAttribute("style", styleCss({ ...s, name: valid ? s.name : "x" }));
    sample.textContent = L("FontStyle.Sample");
    row.querySelector(".gct-fs-code").textContent = `{@${s.name || "…"} …}`;
  }

  static #onAdd() {
    this.#syncRows();
    this.#rows.push({ id: foundry.utils.randomID(8), name: "", family: "", size: null, color: null, bold: false, italic: false });
    this.render();
  }

  static #onRemove(event, target) {
    this.#syncRows();
    const id = target.closest(".gct-fs-row")?.dataset.id;
    this.#rows = this.#rows.filter((r) => r.id !== id);
    this.render();
  }

  #move(target, dir) {
    this.#syncRows();
    const id = target.closest(".gct-fs-row")?.dataset.id;
    const i = this.#rows.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.#rows.length) return;
    [this.#rows[i], this.#rows[j]] = [this.#rows[j], this.#rows[i]];
    this.render();
  }

  static #onMoveUp(event, target) {
    this.#move(target, -1);
  }

  static #onMoveDown(event, target) {
    this.#move(target, 1);
  }

  static #onCancel() {
    this.close();
  }

  /** Validate (names present, allowed characters, unique) and save the world setting. */
  static async #onSave() {
    if (!game.user.isGM) return ui.notifications.warn(L("FontStyle.GMOnly"));
    this.#syncRows();
    const rows = this.element.querySelectorAll(".gct-fs-row");
    const seen = new Map();
    let bad = 0;
    this.#rows.forEach((r, i) => {
      const ok = isValidStyleName(r.name) && !seen.has(r.name);
      if (ok) seen.set(r.name, i);
      rows[i]?.classList.toggle("invalid", !ok);
      if (!ok) bad++;
    });
    if (bad) return ui.notifications.warn(L("FontStyle.InvalidNames"));
    const list = this.#rows.map(sanitizeStyle).filter(Boolean);
    await store.set({ list });
    ui.notifications.info(L("FontStyle.Saved", { count: list.length }));
    this.close();
  }
}

/* -------------------------------------------- */
/*  API                                         */
/* -------------------------------------------- */

export const fontStylesApi = {
  /** The defined styles. */
  list: () => getFontStyles(),
  /** HTML of `text` (escaped) in the named style, or null when the style does not exist. */
  apply(text, name) {
    const style = getFontStyles().find((s) => s.name === name);
    return style ? fontStyleSpan(style, esc(text)) : null;
  },
  /** Convert `{@name text}` markup in HTML ({ html, unknown, converted }). */
  convert: (html) => convertFontStyles(html),
  /** Spans back to markup. */
  toMarkup: (html) => fontStylesToMarkup(html),
  /** Wrap the chat input's selection in a style. */
  wrapSelection: (name) => wrapSelectionWith(name),
  openMenu: () => openFontMenu(),
  openConfig: () => FontStyleConfig.openConfig(),
};
