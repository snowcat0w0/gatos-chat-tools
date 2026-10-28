import { MODULE_ID, TEMPLATES, L, mod, fmtDate, fmtDateTime, fmtTime, parseDateInput, startOfDay, endOfDay } from "./constants.js";
import { SingletonMixin, confirm, esc, escapeRegExp, formDialog, jumpToMessage, promptText, readForm, renderTemplate } from "./lib.js";
import { addToolsButton } from "./chat-controls.js";
import { setting } from "./settings.js";
import {
  getIndex,
  loadArchive,
  isArchivedMessageVisible,
  serializeMessage,
  renderMessageContent,
  collectMessages,
  liveMessageCount,
  resolveRange,
  saveArchive,
  renameArchive,
  removeArchive,
  deleteMessagesInRange,
  deleteMessagesChunked,
  downloadArchiveJson,
  importArchiveFile,
  mergeArchives,
} from "./archive.js";
import { htmlToText, secretLabel } from "./export.js";
import { openExportDialog } from "./export-dialog.js";
import { groupSerialized } from "./grouping.js";
import { pastelOf, stripChitchatMarkup } from "./chitchat.js";
import { canDelete } from "./edit.js";
import { getBookmarks, setBookmarks, toggleBookmark } from "./bookmarks.js";
import { getSession, sessionLabel, openStartSessionDialog, openEndSessionDialog } from "./session.js";
import { viewerActions, getViewerAction } from "./viewer-actions.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PAGE = 200;

/** The one viewer object of this session (0.5.2 kept it in a static field, so filters and source survive close/open). */
let kept = null;

/**
 * gatos-lib SingletonMixin: `instance` is the open window or null, `open()` creates or re-renders it.
 * `open()` re-renders an open viewer like 0.5.2's `instance.render({ force: true })` and reuses the same object
 * across close/open so the chosen source, filters and selection are kept.
 */
export class ChatArchiveViewer extends SingletonMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static DEFAULT_OPTIONS = {
    id: "gct-archive-viewer",
    classes: ["gct-viewer"],
    tag: "div",
    window: {
      title: "GCT.Viewer.Title",
      icon: "fa-solid fa-box-archive",
      resizable: true,
      contentClasses: ["gct-viewer-content"],
    },
    position: { width: 980, height: 700 },
    actions: {
      selectSource: ChatArchiveViewer.#onSelectSource,
      saveArchive: ChatArchiveViewer.#onSaveArchive,
      deleteRange: ChatArchiveViewer.#onDeleteRange,
      renameArchive: ChatArchiveViewer.#onRenameArchive,
      deleteArchive: ChatArchiveViewer.#onDeleteArchive,
      downloadArchive: ChatArchiveViewer.#onDownloadArchive,
      importArchive: ChatArchiveViewer.#onImportArchive,
      mergeArchives: ChatArchiveViewer.#onMergeArchives,
      startSession: ChatArchiveViewer.#onStartSession,
      endSession: ChatArchiveViewer.#onEndSession,
      exportDialog: ChatArchiveViewer.#onExportDialog,
      loadMore: ChatArchiveViewer.#onLoadMore,
      jumpTo: ChatArchiveViewer.#onJumpTo,
      toggleBookmark: ChatArchiveViewer.#onToggleBookmark,
      searchPrev: ChatArchiveViewer.#onSearchPrev,
      searchNext: ChatArchiveViewer.#onSearchNext,
      toggleSelectMode: ChatArchiveViewer.#onToggleSelectMode,
      selectAll: ChatArchiveViewer.#onSelectAll,
      clearSelection: ChatArchiveViewer.#onClearSelection,
      bookmarkSelected: ChatArchiveViewer.#onBookmarkSelected,
      exportSelected: ChatArchiveViewer.#onExportSelected,
      deleteSelected: ChatArchiveViewer.#onDeleteSelected,
      viewerAction: ChatArchiveViewer.#onViewerAction,
    },
  };

  static PARTS = {
    body: { template: TEMPLATES.viewer, scrollable: [".gct-sources", ".gct-results"] },
  };

  /** Open the viewer, or re-render it when it is already open. Resolves to the viewer after rendering (0.5.2 shape). */
  static open() {
    const app = (kept ??= new this());
    this.instance = app;
    return app.render({ force: true });
  }

  /** "live" or an archive id. */
  source = "live";
  query = "";
  speaker = "";
  user = "";
  kind = "";
  regex = false;
  from = "";
  to = "";
  limit = PAGE;
  selectMode = false;
  selected = new Set();

  /** Cache of live-message search text and rendered HTML, keyed by message id. */
  #liveText = new Map();
  #liveHTML = new Map();
  #filtered = [];
  #shown = [];
  #searchTimer = null;
  #marks = [];
  #markIndex = -1;
  #lastClicked = null;

  get includeChitchat() {
    return setting("viewerIncludeChitchat");
  }

  /* -------------------------------------------- */

  async _prepareContext() {
    const index = getIndex();
    if (this.source !== "live" && !index.some((a) => a.id === this.source)) this.source = "live";
    const decorate = (e) => ({
      ...e,
      active: e.id === this.source,
      range: e.from === e.to ? fmtDate(e.from) : `${fmtDate(e.from)} ~ ${fmtDate(e.to)}`,
      badge: e.session ? `#${e.session.number}` : e.auto ? "A" : e.merged ? "M" : e.imported ? "I" : "",
      badgeTip: e.session ? L("Session.Badge") : e.auto ? L("Auto.Badge") : e.merged ? L("Files.MergedBadge") : e.imported ? L("Files.ImportedBadge") : "",
    });
    const sessions = index.filter((e) => e.session).sort((a, b) => a.session.number - b.session.number || a.createdAt - b.createdAt).map(decorate);
    const others = index.filter((e) => !e.session).map(decorate);
    const s = getSession();
    return {
      isGM: game.user.isGM,
      sessions,
      others,
      hasArchives: index.length > 0,
      canMerge: game.user.isGM && index.length >= 2,
      session: s ? { label: sessionLabel(s), started: fmtDateTime(s.startedAt), count: collectMessages({ from: s.startedAt }).length } : null,
      liveActive: this.source === "live",
      liveCount: liveMessageCount(),
      query: this.query,
      regex: this.regex,
      from: this.from,
      to: this.to,
      includeChitchat: this.includeChitchat,
      selectMode: this.selectMode,
      extraActions: viewerActions().map((a) => ({
        id: a.id,
        label: game.i18n.localize(a.label),
        tooltip: a.tooltip ? game.i18n.localize(a.tooltip) : "",
        icon: a.icon ?? "fa-solid fa-puzzle-piece",
        selection: a.selection !== false,
      })),
      kinds: ["", "rolls", "whispers", "chitchat", "bookmarks", "highlights", "markers"].map((k) => ({
        value: k,
        label: L(`Viewer.Kind.${k || "all"}`),
        selected: k === this.kind,
      })),
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    el.classList.toggle("gct-select-mode", this.selectMode);
    const search = el.querySelector("input[name=query]");
    search?.addEventListener("input", () => {
      clearTimeout(this.#searchTimer);
      this.#searchTimer = setTimeout(() => {
        this.query = search.value;
        this.limit = PAGE;
        this.refresh();
      }, 250);
    });
    search?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      this.#step(ev.shiftKey ? -1 : 1);
    });
    const bind = (selector, prop, transform = (v) => v) => {
      el.querySelector(selector)?.addEventListener("change", (ev) => {
        this[prop] = transform(ev.currentTarget);
        this.limit = PAGE;
        this.refresh();
      });
    };
    bind("select[name=speaker]", "speaker", (t) => t.value);
    bind("select[name=user]", "user", (t) => t.value);
    bind("select[name=kind]", "kind", (t) => t.value);
    bind("input[name=regex]", "regex", (t) => t.checked);
    bind("input[name=from]", "from", (t) => t.value);
    bind("input[name=to]", "to", (t) => t.value);
    el.querySelector("input[name=chitchat]")?.addEventListener("change", async (ev) => {
      await game.settings.set(MODULE_ID, "viewerIncludeChitchat", ev.currentTarget.checked);
      this.limit = PAGE;
      this.refresh();
    });
    el.querySelector(".gct-import-input")?.addEventListener("change", (ev) => this.#import(ev.currentTarget));
    // Card checkboxes (select mode); shift-click selects a range.
    el.querySelector(".gct-results")?.addEventListener("click", (ev) => {
      const box = ev.target.closest("input.gct-select");
      if (!box) return;
      const id = box.closest("[data-message-id]")?.dataset.messageId;
      if (!id) return;
      const ids = this.#shown.map((m) => m.id);
      if (ev.shiftKey && this.#lastClicked && ids.includes(this.#lastClicked)) {
        const [a, b] = [ids.indexOf(this.#lastClicked), ids.indexOf(id)].sort((x, y) => x - y);
        for (const rid of ids.slice(a, b + 1)) box.checked ? this.selected.add(rid) : this.selected.delete(rid);
        this.#syncChecks();
      } else if (box.checked) this.selected.add(id);
      else this.selected.delete(id);
      this.#lastClicked = id;
      this.#updateSelectBar();
    });
    await this.refresh({ speakers: true });
  }

  /* -------------------------------------------- */
  /*  Data                                        */
  /* -------------------------------------------- */

  /** All messages of the current source as serialized objects (unfiltered, visible to this user). */
  async #getMessages() {
    if (this.source === "live") {
      const docs = collectMessages().filter((m) => m.visible);
      return Promise.all(docs.map((m) => serializeMessage(m, { render: false })));
    }
    const entry = getIndex().find((e) => e.id === this.source);
    if (!entry) return [];
    try {
      const data = await loadArchive(entry);
      // Archives saved before the fix carry the chitchat wrapper in their HTML.
      return (data.messages ?? []).filter(isArchivedMessageVisible).map((m) => (m.chitchat && m.html ? { ...m, html: stripChitchatMarkup(m.html) } : m));
    } catch (err) {
      ui.notifications.error(err.message);
      return [];
    }
  }

  #searchText(m) {
    if (this.source === "live") {
      const cached = this.#liveText.get(m.id);
      if (cached && cached.ts === m.timestamp && cached.content === m.content && cached.flavor === m.flavor) return cached.text;
    }
    const text = [m.alias, m.user, htmlToText(m.flavor), htmlToText(m.html || m.content), ...(m.rolls ?? []).map((r) => r.formula)].join("\n");
    if (this.source === "live") this.#liveText.set(m.id, { ts: m.timestamp, content: m.content, flavor: m.flavor, text });
    return text;
  }

  /** The search pattern: null (no query), false (invalid regex) or a case-insensitive RegExp source. */
  #pattern() {
    const q = this.query.trim();
    if (!q) return null;
    if (!this.regex) return escapeRegExp(q);
    try {
      new RegExp(q, "imu");
      return q;
    } catch {
      return false;
    }
  }

  #matchesKind(m, bookmarks) {
    switch (this.kind) {
      case "rolls":
        return !!m.isRoll || /dice-roll/.test(m.html || m.content || "");
      case "whispers":
        return !!(m.whisper?.length || m.blind);
      case "chitchat":
        return !!m.chitchat;
      case "bookmarks":
        return !!bookmarks[m.id];
      case "highlights":
        return !!m.highlight;
      case "markers":
        return !!m.sessionMarker;
      default:
        return true;
    }
  }

  #applyFilters(messages) {
    const pattern = this.#pattern();
    const re = pattern ? new RegExp(pattern, "imu") : null;
    const from = parseDateInput(this.from);
    const to = parseDateInput(this.to);
    const fromTs = from != null ? startOfDay(from) : null;
    const toTs = to != null ? endOfDay(to) : null;
    const chitchat = this.includeChitchat || this.kind === "chitchat";
    const bookmarks = getBookmarks();
    return messages.filter((m) => {
      if (!chitchat && m.chitchat) return false;
      if (fromTs != null && m.timestamp < fromTs) return false;
      if (toTs != null && m.timestamp > toTs) return false;
      if (this.speaker && m.alias !== this.speaker) return false;
      if (this.user && m.user !== this.user) return false;
      if (!this.#matchesKind(m, bookmarks)) return false;
      if (re && !re.test(this.#searchText(m))) return false;
      return true;
    });
  }

  /** Ensure displayed live messages have rendered HTML. */
  async #hydrate(slice) {
    if (this.source !== "live") return;
    await Promise.all(
      slice.map(async (m) => {
        const doc = game.messages.get(m.id);
        if (!doc) return;
        const cached = this.#liveHTML.get(m.id);
        if (cached && cached.content === doc.content && cached.flavor === doc.flavor) {
          m.html = cached.html;
          return;
        }
        m.html = await renderMessageContent(doc);
        if (m.chitchat) m.html = stripChitchatMarkup(m.html);
        this.#liveHTML.set(m.id, { content: doc.content, flavor: doc.flavor, html: m.html });
      })
    );
  }

  /* -------------------------------------------- */
  /*  Results rendering                           */
  /* -------------------------------------------- */

  /** Recompute the filtered list and redraw the results pane. */
  async refresh({ speakers = false } = {}) {
    const el = this.element;
    if (!el) return;
    const results = el.querySelector(".gct-results");
    if (!results) return;
    results.innerHTML = `<li class="gct-empty">${L("Viewer.Loading")}</li>`;

    const all = await this.#getMessages();
    if (speakers) this.#fillFilters(all);
    this.#filtered = this.#applyFilters(all);
    const slice = this.#filtered.slice(0, this.limit);
    this.#shown = slice;
    await this.#hydrate(slice);

    const live = this.source === "live";
    const groups = groupSerialized(slice);
    const brightness = setting("chitchatBrightness");
    const showPortrait = setting("showPortrait");
    const bookmarks = getBookmarks();
    const html = await renderTemplate(TEMPLATES.messages, {
      live,
      portraitShape: setting("portraitShape"),
      portraitSize: setting("portraitSize"),
      messages: slice.map((m, i) => {
        const g = m.sessionMarker ? null : groups[i];
        const cont = g === "middle" || g === "end";
        return {
          id: m.id,
          img: showPortrait && !m.chitchat && !m.sessionMarker ? m.img || null : null,
          imgTitle: m.imgLabel ? `${m.alias || m.user} · ${m.imgLabel}` : m.alias || m.user,
          alias: m.alias || m.user,
          user: m.user && m.user !== m.alias ? m.user : "",
          time: fmtTime(m.timestamp),
          timeFull: fmtDateTime(m.timestamp),
          day: fmtDate(m.timestamp),
          flavor: m.flavor,
          html: m.html || m.content,
          secret: secretLabel(m),
          chitchat: !!m.chitchat,
          marker: !!m.sessionMarker,
          bookmarked: !!bookmarks[m.id],
          checked: this.selected.has(m.id),
          ccColor: m.chitchat ? m.color ?? "#888888" : null,
          ccBg: m.chitchat ? pastelOf(m.color ?? "#888888", brightness) : null,
          cont,
          cls: [
            m.blind ? "blind" : "",
            m.whisper?.length ? "whisper" : "",
            m.chitchat ? "gct-chitchat" : "",
            m.highlight ? "gct-highlighted" : "",
            m.sessionMarker ? "gct-marker" : "",
            bookmarks[m.id] ? "gct-bookmarked" : "",
            g ? `gct-group-${g}` : "",
            cont ? "gct-cont" : "",
          ]
            .filter(Boolean)
            .join(" "),
        };
      }),
      hasMore: this.#filtered.length > slice.length,
      remaining: this.#filtered.length - slice.length,
    });
    results.innerHTML = html;
    this.#insertDayDividers(results);

    const pattern = this.#pattern();
    el.querySelector("input[name=query]")?.classList.toggle("gct-invalid", pattern === false);
    if (pattern) highlight(results, new RegExp(pattern, "gimu"));
    this.#marks = [...results.querySelectorAll("mark.gct-hl")];
    this.#markIndex = -1;
    this.#updateNav();

    const count = el.querySelector(".gct-count");
    if (count) count.textContent = L("Viewer.Count", { shown: this.#filtered.length, total: all.length });
    this.#updateSelectBar();
  }

  #insertDayDividers(results) {
    let last = "";
    for (const li of [...results.querySelectorAll("li.gct-msg")]) {
      const day = li.dataset.day;
      if (day && day !== last) {
        const div = document.createElement("li");
        div.className = "gct-day";
        div.textContent = day;
        li.before(div);
        last = day;
      }
    }
  }

  #fillFilters(all) {
    const fill = (name, values, current, allLabel) => {
      const select = this.element?.querySelector(`select[name=${name}]`);
      if (!select) return current;
      const list = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, game.i18n.lang));
      if (!list.includes(current)) current = "";
      select.innerHTML = `<option value="">${esc(allLabel)}</option>` + list.map((n) => `<option value="${esc(n)}"${n === current ? " selected" : ""}>${esc(n)}</option>`).join("");
      return current;
    };
    this.speaker = fill("speaker", all.map((m) => m.alias || m.user), this.speaker, L("Viewer.AllSpeakers"));
    this.user = fill("user", all.map((m) => m.user), this.user, L("Viewer.AllUsers"));
  }

  #exportMeta() {
    const entry = this.source === "live" ? null : getIndex().find((e) => e.id === this.source);
    const source = entry ? entry.name : L("Viewer.Live");
    return { title: `${game.world.title} - ${source}`, source };
  }

  /* -------------------------------------------- */
  /*  Search navigation                           */
  /* -------------------------------------------- */

  #updateNav() {
    const nav = this.element?.querySelector(".gct-nav-count");
    if (nav) nav.textContent = this.#marks.length ? `${this.#markIndex + 1}/${this.#marks.length}` : "0/0";
  }

  #step(dir) {
    if (!this.#marks.length) return;
    this.#marks[this.#markIndex]?.classList.remove("current");
    this.#markIndex = (this.#markIndex + dir + this.#marks.length) % this.#marks.length;
    const mark = this.#marks[this.#markIndex];
    mark.classList.add("current");
    mark.scrollIntoView({ block: "center" });
    this.#updateNav();
  }

  static #onSearchPrev() {
    this.#step(-1);
  }

  static #onSearchNext() {
    this.#step(1);
  }

  /* -------------------------------------------- */
  /*  Selection                                   */
  /* -------------------------------------------- */

  #syncChecks() {
    for (const box of this.element?.querySelectorAll(".gct-results input.gct-select") ?? []) {
      box.checked = this.selected.has(box.closest("[data-message-id]")?.dataset.messageId);
    }
  }

  #updateSelectBar() {
    const bar = this.element?.querySelector(".gct-selectbar");
    if (!bar) return;
    bar.hidden = !this.selectMode;
    const n = this.selected.size;
    bar.querySelector(".gct-select-count").textContent = L("Select.Count", { count: n });
    bar.querySelectorAll("[data-needs-selection]").forEach((b) => (b.disabled = !n));
    const del = bar.querySelector("[data-action=deleteSelected]");
    if (del) del.hidden = this.source !== "live";
  }

  #selectedMessages() {
    return this.#filtered.filter((m) => this.selected.has(m.id));
  }

  static async #onToggleSelectMode() {
    this.selectMode = !this.selectMode;
    if (!this.selectMode) this.selected.clear();
    this.element.classList.toggle("gct-select-mode", this.selectMode);
    this.element.querySelector("[data-action=toggleSelectMode]")?.classList.toggle("active", this.selectMode);
    this.#syncChecks();
    this.#updateSelectBar();
  }

  static #onSelectAll() {
    for (const m of this.#filtered) this.selected.add(m.id);
    this.#syncChecks();
    this.#updateSelectBar();
  }

  static #onClearSelection() {
    this.selected.clear();
    this.#syncChecks();
    this.#updateSelectBar();
  }

  static async #onBookmarkSelected() {
    const ids = [...this.selected];
    if (!ids.length) return;
    await setBookmarks(ids, true);
    ui.notifications.info(L("Select.Bookmarked", { count: ids.length }));
    await this.refresh();
  }

  static async #onExportSelected() {
    const list = this.#selectedMessages();
    if (!list.length) return ui.notifications.warn(L("Viewer.NothingToExport"));
    await this.#hydrate(list);
    const meta = this.#exportMeta();
    await openExportDialog({ messages: list, title: `${meta.title} (${L("Select.Short")})`, source: meta.source, includeChitchat: true });
  }

  static async #onDeleteSelected() {
    if (this.source !== "live") return;
    const docs = [...this.selected].map((id) => game.messages.get(id)).filter((m) => m && canDelete(m));
    if (!docs.length) return ui.notifications.warn(L("Select.NothingDeletable"));
    const ok = await confirm({ title: L("Select.DeleteTitle"), content: `<p>${esc(L("Select.DeleteConfirm", { count: docs.length }))}</p>` });
    if (!ok) return;
    await deleteMessagesChunked(docs.map((m) => m.id));
    for (const m of docs) this.selected.delete(m.id);
    await this.render();
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onSelectSource(event, target) {
    if (event.target.closest(".gct-source-actions")) return;
    this.source = target.dataset.source;
    this.limit = PAGE;
    this.speaker = "";
    this.user = "";
    this.selected.clear();
    await this.render();
  }

  static async #onSaveArchive() {
    const entry = await openSaveDialog();
    if (entry) {
      this.source = entry.id;
      await this.render();
    }
  }

  static async #onDeleteRange() {
    const n = await openDeleteDialog();
    if (n) {
      this.source = "live";
      await this.render();
    }
  }

  static async #onStartSession() {
    if (await openStartSessionDialog()) await this.render();
  }

  static async #onEndSession() {
    const entry = await openEndSessionDialog();
    if (entry) this.source = entry.id;
    await this.render();
  }

  static async #onRenameArchive(event, target) {
    const entry = getIndex().find((e) => e.id === target.dataset.id);
    if (!entry) return;
    const name = await promptText({ title: L("Archive.RenameTitle"), label: L("Archive.Name"), value: entry.name, ok: { label: L("Save") } });
    if (name) {
      await renameArchive(entry.id, name);
      await this.render();
    }
  }

  static async #onDeleteArchive(event, target) {
    const entry = getIndex().find((e) => e.id === target.dataset.id);
    if (!entry) return;
    const result = await formDialog({
      title: L("Archive.DeleteConfirmTitle"),
      content: `<p>${esc(L("Archive.DeleteConfirm", { name: entry.name, path: entry.path }))}</p>
        <label class="gct-check-row"><input type="checkbox" name="clearFile"> ${esc(L("Files.ClearFile"))}</label>
        <p class="hint">${esc(L("Files.ClearFileHint"))}</p>`,
      ok: { action: "delete", label: L("Delete"), icon: "fa-solid fa-trash", default: false, read: (button) => ({ clearFile: !!button.form.elements.clearFile?.checked }) },
      cancel: { label: L("Cancel"), default: true },
    });
    if (!result) return;
    try {
      await removeArchive(entry.id, result);
    } catch (err) {
      ui.notifications.error(L("Files.Failed", { error: err.message }));
    }
    if (this.source === entry.id) this.source = "live";
    await this.render();
  }

  static async #onDownloadArchive(event, target) {
    const entry = getIndex().find((e) => e.id === target.dataset.id);
    if (!entry) return;
    try {
      await downloadArchiveJson(entry);
    } catch (err) {
      ui.notifications.error(err.message);
    }
  }

  static #onImportArchive() {
    this.element.querySelector(".gct-import-input")?.click();
  }

  async #import(input) {
    const files = [...(input.files ?? [])];
    input.value = "";
    let last = null;
    for (const file of files) {
      try {
        last = await importArchiveFile(file);
        if (last) ui.notifications.info(L("Files.Imported", { name: last.name, count: last.count }));
      } catch (err) {
        ui.notifications.error(L("Files.Failed", { error: err.message }));
      }
    }
    if (last) {
      this.source = last.id;
      await this.render();
    }
  }

  static async #onMergeArchives() {
    const index = getIndex();
    if (index.length < 2) return ui.notifications.warn(L("Files.MergeNeedTwo"));
    const rows = index
      .map((e) => `<label class="gct-check-row"><input type="checkbox" name="merge" value="${esc(e.id)}"${e.id === this.source ? " checked" : ""}> ${esc(e.name)} <span class="gct-dim">(${esc(fmtDate(e.from))} · ${e.count})</span></label>`)
      .join("");
    const result = await formDialog({
      title: L("Files.MergeTitle"),
      icon: "fa-solid fa-object-group",
      classes: ["gct-merge-dialog"],
      width: 480,
      content: `<div class="gct-merge-list">${rows}</div>
        <div class="form-group"><label>${esc(L("Archive.Name"))}</label><div class="form-fields"><input type="text" name="name" placeholder="${esc(L("Files.MergeNameHint"))}"></div></div>
        <label class="gct-check-row"><input type="checkbox" name="removeOriginals"> ${esc(L("Files.MergeRemove"))}</label>`,
      ok: {
        action: "merge",
        label: L("Files.Merge"),
        icon: "fa-solid fa-object-group",
        read: (button) => ({
          ids: [...button.form.querySelectorAll("input[name=merge]:checked")].map((i) => i.value),
          name: button.form.elements.name.value,
          removeOriginals: !!button.form.elements.removeOriginals.checked,
        }),
      },
      cancel: { label: L("Cancel") },
    });
    if (!result) return;
    try {
      const entry = await mergeArchives(result.ids, result);
      if (entry) {
        ui.notifications.info(L("Files.Merged", { name: entry.name, count: entry.count }));
        this.source = entry.id;
        await this.render();
      }
    } catch (err) {
      ui.notifications.error(L("Files.Failed", { error: err.message }));
    }
  }

  static async #onExportDialog() {
    if (!this.#filtered.length) return ui.notifications.warn(L("Viewer.NothingToExport"));
    // The viewer's chitchat checkbox already filtered the list; the dialog still offers its own toggle
    // for the case where chitchat is shown here but should be left out of the file.
    await this.#hydrate(this.#filtered);
    await openExportDialog({ messages: this.#filtered, ...this.#exportMeta(), includeChitchat: this.includeChitchat });
  }

  /** A button registered with registerViewerAction: run it on the listed (or, in the selection bar, selected) messages. */
  static async #onViewerAction(event, target) {
    const action = getViewerAction(target.dataset.id);
    if (!action) return;
    const selection = !!target.closest(".gct-selectbar");
    const list = selection ? this.#selectedMessages() : this.#filtered;
    if (!list.length) return ui.notifications.warn(L("Viewer.NothingToExport"));
    await this.#hydrate(list);
    const meta = this.#exportMeta();
    try {
      await action.callback(list, { ...meta, title: selection ? `${meta.title} (${L("Select.Short")})` : meta.title, selection });
    } catch (err) {
      mod.error(`viewer action ${action.id} failed`, err);
      ui.notifications.error(err.message);
    }
  }

  static async #onLoadMore() {
    this.limit += PAGE;
    await this.refresh();
  }

  static async #onToggleBookmark(event, target) {
    const li = target.closest("[data-message-id]");
    const id = li?.dataset.messageId;
    if (!id) return;
    await toggleBookmark(id);
    const on = !!getBookmarks()[id];
    li.classList.toggle("gct-bookmarked", on);
    target.querySelector("i")?.classList.toggle("fa-solid", on);
    target.querySelector("i")?.classList.toggle("fa-regular", !on);
  }

  static async #onJumpTo(event, target) {
    const id = target.closest("[data-message-id]")?.dataset.messageId;
    // gatos-lib: scroll + flash in the chat log (sidebar or popout), else open the message in a popout.
    jumpToMessage(id, { flashClass: "gct-flash", duration: 1600 });
  }
}

/* -------------------------------------------- */
/*  Search highlighting                         */
/* -------------------------------------------- */

/** Wrap every match of a global RegExp inside the text nodes of `root` in <mark class="gct-hl">. */
function highlight(root, re) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const p = node.parentElement;
      if (!p || p.closest("script, style, .gct-more, .gct-day, .gct-msg-tools")) return NodeFilter.FILTER_REJECT;
      re.lastIndex = 0;
      return re.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let i = 0;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      if (m.index > i) frag.append(text.slice(i, m.index));
      const mark = document.createElement("mark");
      mark.className = "gct-hl";
      mark.textContent = m[0];
      frag.append(mark);
      i = m.index + m[0].length;
    }
    if (i < text.length) frag.append(text.slice(i));
    node.replaceWith(frag);
  }
}

/* -------------------------------------------- */
/*  Range dialogs (save / delete)               */
/* -------------------------------------------- */

function bindRangeForm(dialog, readRange) {
  const root = dialog?.element ?? document;
  const form = root.querySelector?.("form.dialog-form, form") ?? root;
  const rangeSel = form.querySelector("select[name=range]");
  const custom = form.querySelector(".gct-custom-range");
  const preview = form.querySelector(".gct-preview-count");
  const update = () => {
    custom.hidden = rangeSel.value !== "custom";
    preview.textContent = collectMessages(readRange(form)).length;
  };
  form.addEventListener("change", update);
  form.addEventListener("input", update);
  update();
}

const readRangeForm = (form) => {
  const fd = readForm(form);
  return resolveRange(fd.range, parseDateInput(fd.from), parseDateInput(fd.to));
};

/** Open the GM save dialog; resolves to the new index entry or null. */
export async function openSaveDialog() {
  if (!game.user.isGM) return ui.notifications.warn(L("Archive.GMOnly")), null;
  const last = setting("lastArchived");
  const content = await renderTemplate(TEMPLATES.save, {
    name: L("Archive.DefaultName", { world: game.world.title, date: fmtDate(Date.now()) }),
    hasLast: last > 0,
    lastDate: last > 0 ? fmtDateTime(last) : "",
    today: fmtDate(Date.now()),
  });

  const result = await formDialog({
    title: L("Archive.SaveTitle"),
    icon: "fa-solid fa-box-archive",
    classes: ["gct-save-dialog"],
    width: 480,
    content,
    render: (event, dialog) => bindRangeForm(dialog, readRangeForm),
    ok: {
      action: "save",
      label: L("Save"),
      icon: "fa-solid fa-floppy-disk",
      read: (button) => {
        const fd = readForm(button.form);
        return { name: fd.name, deleteAfter: !!fd.deleteAfter, ...readRangeForm(button.form) };
      },
    },
    cancel: { label: L("Cancel") },
  });
  if (!result) return null;
  return saveArchive(result);
}

/** Open the GM dialog that deletes current chat messages in a date range; resolves to the number deleted. */
export async function openDeleteDialog() {
  if (!game.user.isGM) return ui.notifications.warn(L("Archive.GMOnly")), 0;
  const last = setting("lastArchived");
  const content = await renderTemplate(TEMPLATES.delete, {
    hasLast: last > 0,
    lastDate: last > 0 ? fmtDateTime(last) : "",
    today: fmtDate(Date.now()),
  });

  const range = await formDialog({
    title: L("DeleteRange.Title"),
    icon: "fa-solid fa-trash",
    classes: ["gct-delete-dialog"],
    width: 480,
    content,
    render: (event, dialog) => bindRangeForm(dialog, readRangeForm),
    ok: { action: "delete", label: L("Delete"), icon: "fa-solid fa-trash", default: false, read: (button) => readRangeForm(button.form) },
    cancel: { label: L("Cancel"), default: true },
  });
  if (!range) return 0;

  const count = collectMessages(range).length;
  if (!count) return ui.notifications.warn(L("DeleteRange.NoMessages")), 0;
  const ok = await confirm({ title: L("DeleteRange.Title"), content: `<p>${esc(L("DeleteRange.Confirm", { count }))}</p>` });
  if (!ok) return 0;
  return deleteMessagesInRange(range);
}

/* -------------------------------------------- */
/*  Chat controls button                        */
/* -------------------------------------------- */

/** Add the archive/search button to the module's chat-controls row (idempotent; appends `button.ui-control.icon`). */
export function injectChatButton() {
  addToolsButton({ cls: "gct-open-viewer", icon: "fa-solid fa-box-archive", label: L("Chat.OpenViewer"), onClick: () => ChatArchiveViewer.open() });
}

/** Re-render the open viewer when the user's bookmarks change (another window, the chat context menu). */
export function onBookmarksChanged() {
  const viewer = ChatArchiveViewer.instance;
  if (viewer?.rendered) viewer.refresh();
}

/** Keep the session box's message count and the live count current while the viewer is open. */
export function onChatMessageCountChanged() {
  const viewer = ChatArchiveViewer.instance;
  const el = viewer?.rendered ? viewer.element : null;
  if (!el) return;
  const live = el.querySelector('.gct-source[data-source="live"] .meta');
  if (live) live.textContent = liveMessageCount();
  const s = getSession();
  const meta = el.querySelector(".gct-session-box.active .meta");
  if (s && meta) meta.textContent = L("Session.Since", { time: fmtDateTime(s.startedAt), count: collectMessages({ from: s.startedAt }).length });
}
