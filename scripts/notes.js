import { MODULE_ID, L, mod, isNote, fmtDateTime } from "./constants.js";
import { SingletonMixin, addChatControl, debounce, esc, formDialog, htmlRoot, userFlagStore, wrapMethod } from "./lib.js";
import { htmlToPlain } from "./chat-input.js";
import { bindComposer, keepScroll, shortTime, userColor } from "./panel.js";

/*
 * Shared notes (system-agnostic): public ChatMessages flagged `flags.gatos-chat-tools.note`, created without a
 * chat bubble, notification or sound (v13: the notification is filtered in a ChatLog#notify wrapper).
 * The chat log hides them (render hook + CSS), and every "chat message"
 * consumer of this module skips them: grouping, portraits / speaker lock, archive collection, exports,
 * automatic archiving counts, reorder, session counts, range deletion (collectMessages filters them).
 * They live in a floating panel instead, where everybody reads them and writes new ones.
 * Text is stored escaped (line breaks as <br>) and always shown through plain-text conversion + escaping.
 */

/** Unsent text, per user (debounced user flag). */
const draftStore = userFlagStore(mod, "noteDraft", { default: "" });

/** All notes, oldest first. */
export function getNotes() {
  return game.messages.contents.filter((m) => isNote(m)).sort((a, b) => a.timestamp - b.timestamp);
}

/** A note's text (line breaks kept), whatever HTML its content holds. */
export function noteText(message) {
  return htmlToPlain(message?.content ?? "").trim();
}

/** Stored HTML for a note's text: escaped, line breaks as <br>. */
function noteHtml(text) {
  return esc(text).replace(/\r?\n/g, "<br>");
}

/** May the current user edit / delete this note? Its author or a GM. */
export function canEditNote(message) {
  return !!message && (game.user.isGM || message.author?.id === game.user.id);
}

/** Create a note. Resolves to the message; throws on failure. */
export async function createNote(text) {
  const body = String(text ?? "").trim();
  if (!body) return null;
  return ChatMessage.create(
    {
      author: game.user.id,
      speaker: { scene: null, actor: null, token: null, alias: game.user.name },
      style: CONST.CHAT_MESSAGE_STYLES.OOC,
      content: noteHtml(body),
      sound: null,
      flags: { [MODULE_ID]: { note: true } },
    },
    // No bubble over a token. v13 ChatMessage#_onCreate ignores `notify` / `scroll` (it always calls
    // ui.chat.postOne(this, {notify: true})), so the notification card / pip is suppressed by the ChatLog#notify
    // wrapper in registerNotesHooks; the posted <li> is hidden by onRenderChatMessageNote. No sound (sound: null).
    { chatBubble: false }
  );
}

/* -------------------------------------------- */
/*  Chat log                                    */
/* -------------------------------------------- */

/** renderChatMessageHTML: keep notes out of the chat log and the notification cards. */
export function onRenderChatMessageNote(message, html) {
  if (!isNote(message)) return;
  const li = htmlRoot(html);
  if (!li) return;
  li.classList.add("gct-note");
  li.hidden = true;
}

/* -------------------------------------------- */
/*  Panel                                       */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

export class NotesPanel extends SingletonMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "gct-notes-panel",
    classes: ["gct-panel", "gct-notes-panel"],
    tag: "div",
    window: {
      title: "GCT.Notes.Title",
      icon: "fa-solid fa-note-sticky",
      resizable: true,
      controls: [
        { action: "exportJournal", icon: "fa-solid fa-book", label: "GCT.Notes.ExportJournal", visible: () => game.user.can("JOURNAL_CREATE") },
        { action: "copyText", icon: "fa-solid fa-copy", label: "GCT.Notes.CopyText" },
      ],
    },
    position: { width: 380, height: 520 },
    actions: {
      sendNote: NotesPanel.#onSend,
      editNote: NotesPanel.#onEdit,
      exportJournal: NotesPanel.#onExportJournal,
      copyText: NotesPanel.#onCopyText,
    },
    gatos: { persistPosition: { mod, key: "notesPanelPosition" } },
  };

  #saveDraft = debounce((text) => draftStore.set(text || null).catch((err) => mod.warn("note draft not saved", err)), 800);
  #sending = false;

  async _renderHTML() {
    return `<div class="gct-panel-body">
      <ol class="gct-panel-list gct-note-list"></ol>
      <div class="gct-panel-compose">
        <textarea name="note" rows="3" placeholder="${esc(L("Notes.Placeholder"))}"></textarea>
        <button type="button" data-action="sendNote" data-tooltip="${esc(L("Notes.Send"))}" aria-label="${esc(L("Notes.Send"))}"><i class="fa-solid fa-paper-plane"></i></button>
      </div>
      <p class="gct-panel-hint">${esc(L("Panel.ComposeHint"))}</p>
    </div>`;
  }

  /** The frame is built once; later renders only refresh the list so typing is never interrupted. */
  _replaceHTML(result, content, options) {
    if (options.isFirstRender || !content.querySelector(".gct-note-list")) {
      content.innerHTML = result;
      const textarea = content.querySelector("textarea");
      textarea.value = draftStore.get() ?? "";
      bindComposer(textarea, () => this.#send());
      textarea.addEventListener("input", () => this.#saveDraft(textarea.value));
      content.querySelector(".gct-note-list").addEventListener("contextmenu", (ev) => {
        const li = ev.target.closest("[data-message-id]");
        if (!li) return;
        ev.preventDefault();
        openNoteEditor(game.messages.get(li.dataset.messageId));
      });
    }
    this.refreshList();
  }

  /** Start at the newest note (the list exists in the DOM only from here on). */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const list = this.element?.querySelector(".gct-note-list");
    if (options.isFirstRender && list) list.scrollTop = list.scrollHeight;
  }

  /** Redraw the note list only (create / update / delete on any client). */
  refreshList() {
    const list = this.element?.querySelector(".gct-note-list");
    if (!list) return;
    const notes = getNotes();
    return keepScroll(list, () => {
      list.innerHTML = notes.length ? notes.map((m) => noteItemHtml(m)).join("") : `<li class="gct-panel-empty">${esc(L("Notes.Empty"))}</li>`;
    });
  }

  /** Send: create the message first, then clear the draft; on failure put the text back. */
  async #send() {
    if (this.#sending) return;
    const textarea = this.element?.querySelector("textarea[name=note]");
    const text = textarea?.value ?? "";
    if (!text.trim()) return;
    this.#sending = true;
    this.#saveDraft.cancel();
    textarea.value = "";
    try {
      await createNote(text);
      await draftStore.set(null);
    } catch (err) {
      mod.error("note create failed", err);
      if (!textarea.value) textarea.value = text;
      ui.notifications.error(L("Notes.SendFailed", { error: err?.message ?? err }));
    } finally {
      this.#sending = false;
      textarea.focus();
    }
  }

  static #onSend() {
    return this.#send();
  }

  static #onEdit(event, target) {
    const id = target.closest("[data-message-id]")?.dataset.messageId;
    return openNoteEditor(game.messages.get(id));
  }

  static #onExportJournal() {
    return exportNotesToJournal();
  }

  static #onCopyText() {
    return copyNotesAsText();
  }

  _onClose(options) {
    this.#saveDraft.flush();
    super._onClose(options);
  }
}

/** One list entry: author (user colour), time, edit button for author / GM, escaped text. */
function noteItemHtml(m) {
  const author = m.author;
  const color = userColor(author);
  const edit = canEditNote(m)
    ? `<a class="gct-note-edit" data-action="editNote" data-tooltip="${esc(L("Notes.Edit"))}" aria-label="${esc(L("Notes.Edit"))}"><i class="fa-solid fa-pen"></i></a>`
    : "";
  return `<li class="gct-panel-item gct-note-item${author?.isSelf ? " mine" : ""}" data-message-id="${esc(m.id)}">
    <header><strong class="gct-panel-author"${color ? ` style="color:${esc(color)}"` : ""}>${esc(author?.name ?? "?")}</strong>
      <time datetime="${esc(new Date(m.timestamp).toISOString())}" data-tooltip="${esc(fmtDateTime(m.timestamp))}">${esc(shortTime(m.timestamp))}</time>${edit}</header>
    <div class="gct-panel-text">${esc(noteText(m))}</div>
  </li>`;
}

/** Edit / delete dialog for the author or a GM. */
export async function openNoteEditor(message) {
  if (!message || !isNote(message)) return;
  if (!canEditNote(message)) return ui.notifications.warn(L("Notes.NoPermission"));
  const content = `<div class="gct-note-editor"><textarea name="text" rows="8" autofocus>${esc(noteText(message))}</textarea></div>`;
  const result = await formDialog({
    title: L("Notes.EditTitle"),
    icon: "fa-solid fa-note-sticky",
    classes: ["gct-note-dialog"],
    width: 480,
    content,
    ok: { action: "save", label: L("Save"), icon: "fa-solid fa-floppy-disk", read: (button) => ({ action: "save", text: button.form?.elements.text?.value ?? "" }) },
    buttons: [{ action: "delete", label: L("Delete"), icon: "fa-solid fa-trash", callback: () => ({ action: "delete" }) }],
    cancel: { label: L("Cancel") },
  });
  if (!result || !game.messages.has(message.id)) return;
  try {
    if (result.action === "delete") await message.delete();
    else if (result.action === "save") {
      const text = String(result.text ?? "").trim();
      if (!text) await message.delete();
      else if (text !== noteText(message)) await message.update({ content: noteHtml(text) });
    }
  } catch (err) {
    mod.error("note edit failed", err);
    ui.notifications.error(L("Notes.EditFailed", { error: err?.message ?? err }));
  }
}

/* -------------------------------------------- */
/*  Export                                      */
/* -------------------------------------------- */

/** All notes as plain text lines: "[yyyy-mm-dd HH:MM:SS] author: text". */
export function notesAsText() {
  return getNotes()
    .map((m) => `[${fmtDateTime(m.timestamp)}] ${m.author?.name ?? "?"}: ${noteText(m)}`)
    .join("\n");
}

export async function copyNotesAsText() {
  const text = notesAsText();
  if (!text) return ui.notifications.warn(L("Notes.Empty"));
  await game.clipboard.copyPlainText(text);
  ui.notifications.info(L("Notes.Copied"));
}

/** Create a new JournalEntry with one text page holding every note (needs JOURNAL_CREATE). */
export async function exportNotesToJournal() {
  if (!game.user.can("JOURNAL_CREATE")) return ui.notifications.warn(L("Notes.NoJournalPermission"));
  const notes = getNotes();
  if (!notes.length) return ui.notifications.warn(L("Notes.Empty"));
  const body = notes
    .map((m) => `<p><strong>${esc(m.author?.name ?? "?")}</strong> <em>${esc(fmtDateTime(m.timestamp))}</em><br>${noteHtml(noteText(m))}</p>`)
    .join("");
  const name = L("Notes.JournalName", { date: fmtDateTime(Date.now()) });
  try {
    const entry = await JournalEntry.create({ name, pages: [{ name: L("Notes.Title"), type: "text", text: { content: body } }] });
    ui.notifications.info(L("Notes.Exported", { name }));
    entry?.sheet?.render(true);
    return entry;
  } catch (err) {
    mod.error("notes journal export failed", err);
    ui.notifications.error(L("Notes.ExportFailed", { error: err?.message ?? err }));
    return null;
  }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

/** The chat-controls button (idempotent). */
export function injectNotesButton() {
  addChatControl({ cls: "gct-open-notes", icon: "fa-solid fa-note-sticky", label: L("Notes.Title"), onClick: () => NotesPanel.toggle() });
}

const refreshPanel = debounce(() => NotesPanel.instance?.refreshList(), 50);

export function registerNotesHooks() {
  // v13: no `notify: false` create option, so keep notes from lighting the chat-tab pip or opening the
  // notification cards (ChatLog#notify, called from ChatLog#postOne for every new message).
  Hooks.once("init", () => {
    wrapMethod(
      mod,
      "foundry.applications.sidebar.tabs.ChatLog.prototype.notify",
      function (wrapped, message, ...args) {
        if (isNote(message)) return;
        return wrapped(message, ...args);
      },
      "MIXED",
      {
        register: (target, fn, type) => libWrapper.register(MODULE_ID, target, fn, type),
        unregister: (id) => libWrapper.unregister(MODULE_ID, id, false),
      }
    );
  });
  for (const hook of ["createChatMessage", "updateChatMessage", "deleteChatMessage"]) {
    Hooks.on(hook, (message) => {
      if (isNote(message)) refreshPanel();
    });
  }
  // Author names / colours.
  Hooks.on("updateUser", (user, changes) => {
    if ("name" in (changes ?? {}) || "color" in (changes ?? {})) refreshPanel();
  });
}
