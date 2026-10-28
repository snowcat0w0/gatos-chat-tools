import { MODULE_ID, L, mod, isNote, fmtDateTime } from "./constants.js";
import { SingletonMixin, debounce, esc, renderMessageContent } from "./lib.js";
import { addToolsButton } from "./chat-controls.js";
import { setting } from "./settings.js";
import { resolveRecipients, describeTarget } from "./whisper.js";
import { isChitchat, stripChitchatMarkup } from "./chitchat.js";
import { bindComposer, keepScroll, shortTime, userColor } from "./panel.js";

/*
 * Whisper conversations: a floating panel with one tab per partner (plus "전체"/All) listing the whisper
 * messages this user can see. A partner tab shows the whispers between me and that user; "All" shows every
 * whisper I can see that involves somebody else (a GM also sees players whispering to each other there).
 * The inline composer whispers to the tab's partner the same way the whisper target does (GMs included for
 * player-to-player whispers, the current speaker, no chat bubble). Unread counts per partner are kept per
 * client (hidden client setting), with a badge on the tabs and on the chat-controls button.
 */

const PAGE = 40;
const ALL = "all";

/* -------------------------------------------- */
/*  Conversations                               */
/* -------------------------------------------- */

/**
 * The recipients a whisper was really meant for: everybody but the author, without the GMs that are added
 * automatically when a whisper also goes to a non-GM user (player-to-player whispers, the whisper target).
 */
export function intendedRecipients(message) {
  const authorId = message.author?.id ?? message._source?.author;
  const ids = [...new Set(message.whisper ?? [])].filter((id) => id !== authorId);
  const nonGM = ids.filter((id) => !game.users.get(id)?.isGM);
  return nonGM.length ? nonGM : ids;
}

/** The partners of a whisper from my point of view (empty when I am neither author nor intended recipient). */
export function partnersOf(message, me = game.user.id) {
  const authorId = message.author?.id ?? message._source?.author;
  const intended = intendedRecipients(message);
  if (authorId === me) return intended.filter((id) => id !== me);
  if (intended.includes(me) && authorId) return [authorId];
  return [];
}

/**
 * Whisper messages this user can see that involve somebody besides the author (no self-only rolls, no notes).
 * `isContentVisible`, not `visible`: core marks every whispered ROLL visible to everybody (shown as "rolled
 * privately"), and the panel prints the raw flavor, so a GM's private roll would leak to the players' "All" tab.
 */
export function visibleWhispers() {
  return game.messages.contents
    .filter((m) => m.whisper?.length && m.isContentVisible && !isNote(m) && intendedRecipients(m).length)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** May the current user start a conversation with this user (world policy `whisperPanelPolicy`)? */
export function canWhisperTo(user) {
  if (!user || user.isSelf) return false;
  if (game.user.isGM || setting("whisperPanelPolicy") === "all") return true;
  return user.isGM;
}

/** Messages of one tab (ALL or a user id). */
function tabMessages(tab, all = visibleWhispers()) {
  if (tab === ALL) return all;
  return all.filter((m) => partnersOf(m).includes(tab));
}

/* -------------------------------------------- */
/*  Unread                                      */
/* -------------------------------------------- */

/** Hidden client setting `whisperPanelRead`: { _base: ts, [userId]: ts } — last-read time per partner. */
function readMap() {
  const value = setting("whisperPanelRead");
  return value && typeof value === "object" ? { ...value } : {};
}

let pendingRead = null;
const saveRead = debounce(() => {
  if (!pendingRead) return;
  game.settings.set(MODULE_ID, "whisperPanelRead", pendingRead).catch((err) => mod.warn("whisper read state not saved", err));
  pendingRead = null;
}, 1000);

/** The first time this client uses the panel, older whispers count as read. */
function baseTime(map) {
  if (!Number.isFinite(map._base)) {
    map._base = Date.now();
    pendingRead = { ...map };
    saveRead();
  }
  return map._base;
}

/** Unread counts: { [partnerId]: n, total }. Only messages written by the partner count. */
export function unreadCounts(all = visibleWhispers()) {
  const map = { ...readMap(), ...(pendingRead ?? {}) };
  const base = baseTime(map);
  const counts = { total: 0 };
  for (const m of all) {
    const authorId = m.author?.id;
    if (!authorId || authorId === game.user.id) continue;
    if (!partnersOf(m).includes(authorId)) continue;
    if (m.timestamp <= (map[authorId] ?? base)) continue;
    counts[authorId] = (counts[authorId] ?? 0) + 1;
    counts.total++;
  }
  return counts;
}

/** Mark a tab (a partner, or every partner for ALL) as read up to now. */
function markRead(tab, all) {
  const map = { ...readMap(), ...(pendingRead ?? {}) };
  baseTime(map);
  const partners = tab === ALL ? [...new Set(all.flatMap((m) => partnersOf(m)))] : [tab];
  let changed = false;
  for (const id of partners) {
    const last = Math.max(0, ...all.filter((m) => m.author?.id === id).map((m) => m.timestamp));
    if (last > (map[id] ?? map._base)) {
      map[id] = last;
      changed = true;
    }
  }
  if (!changed) return false;
  pendingRead = map;
  saveRead();
  return true;
}

/* -------------------------------------------- */
/*  Sending                                     */
/* -------------------------------------------- */

/**
 * Whisper `text` (escaped, line breaks kept) to a user. Speaks like a normal chat message: in the core
 * "in character" mode as the current speaker, otherwise out of character; the speaker lock, the portrait,
 * ruby and font styles apply through the usual preCreate hooks. Never a chat bubble.
 */
export async function sendWhisperTo(userId, text) {
  const partner = game.users.get(userId);
  const body = String(text ?? "").trim();
  if (!partner || !body) return null;
  if (!canWhisperTo(partner)) {
    ui.notifications.warn(L("WhisperPanel.NotAllowed", { name: partner.name }));
    return null;
  }
  const target = { mode: "users", users: [partner.id] };
  const r = resolveRecipients(target);
  let mode = "public";
  try {
    mode = game.settings.get("core", "messageMode");
  } catch {
    /* default */
  }
  const speaker = ChatMessage.getSpeaker();
  const inCharacter = mode === "ic" && !!(speaker.actor || speaker.token);
  const data = {
    author: game.user.id,
    content: esc(body).replace(/\r?\n/g, "<br>"),
    whisper: r?.ids ?? [partner.id],
    style: inCharacter ? CONST.CHAT_MESSAGE_STYLES.IC : CONST.CHAT_MESSAGE_STYLES.OOC,
    flags: { [MODULE_ID]: { whisperTo: { mode: "users", label: describeTarget(target) } } },
  };
  if (inCharacter) data.speaker = speaker;
  return ChatMessage.create(data, { chatBubble: false });
}

/* -------------------------------------------- */
/*  Panel                                       */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

export class WhisperPanel extends SingletonMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "gct-whisper-panel",
    classes: ["gct-panel", "gct-whisper-panel"],
    tag: "div",
    window: { title: "GCT.WhisperPanel.Title", icon: "fa-solid fa-comments", resizable: true },
    position: { width: 440, height: 580 },
    actions: {
      selectTab: WhisperPanel.#onSelectTab,
      loadOlder: WhisperPanel.#onLoadOlder,
      sendWhisper: WhisperPanel.#onSend,
      closeTab: WhisperPanel.#onCloseTab,
    },
    gatos: { persistPosition: { mod, key: "whisperPanelPosition" } },
  };

  /** Open the panel on a partner's tab (or All). */
  static openTo(userId = null) {
    const app = this.open();
    const user = userId ? game.users.get(userId) : null;
    if (user && !user.isSelf) {
      if (canWhisperTo(user)) app.extra.add(user.id); // keep the tab even before the first message
      app.selectTab(user.id);
    }
    return app;
  }

  tab = ALL;
  limit = PAGE;
  /** Partners opened from the picker that have no message yet. */
  extra = new Set();
  /** Rendered message HTML, keyed by id, refreshed when the content changes. */
  #html = new Map();
  #sending = false;
  #drafts = new Map();

  async _renderHTML() {
    return `<div class="gct-panel-body">
      <nav class="gct-wp-tabs" role="tablist"></nav>
      <div class="gct-panel-list gct-wp-log">
        <button type="button" class="gct-wp-older" data-action="loadOlder" hidden><i class="fa-solid fa-angles-up"></i> ${esc(L("WhisperPanel.LoadOlder"))}</button>
        <ol class="gct-wp-messages"></ol>
      </div>
      <div class="gct-panel-compose">
        <textarea name="whisper" rows="2"></textarea>
        <button type="button" data-action="sendWhisper" data-tooltip="${esc(L("WhisperPanel.Send"))}" aria-label="${esc(L("WhisperPanel.Send"))}"><i class="fa-solid fa-paper-plane"></i></button>
      </div>
      <p class="gct-panel-hint"></p>
    </div>`;
  }

  /** Build the frame once; afterwards only tabs and messages are refreshed (the composer keeps its text). */
  _replaceHTML(result, content, options) {
    if (options.isFirstRender || !content.querySelector(".gct-wp-messages")) {
      content.innerHTML = result;
      const textarea = content.querySelector("textarea");
      bindComposer(textarea, () => this.#send());
      textarea.addEventListener("input", () => this.#drafts.set(this.tab, textarea.value));
      content.querySelector(".gct-wp-tabs").addEventListener("change", (ev) => {
        const select = ev.target.closest("select.gct-wp-new");
        if (!select?.value) return;
        const id = select.value;
        select.value = "";
        this.extra.add(id);
        this.selectTab(id);
      });
    }
    this.refresh({ scrollBottom: !!options.isFirstRender });
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const log = this.element?.querySelector(".gct-wp-log");
    if (options.isFirstRender && log) log.scrollTop = log.scrollHeight;
  }

  /** Switch tab: keep each tab's unsent text, start at the newest message. */
  selectTab(tab) {
    const textarea = this.element?.querySelector("textarea[name=whisper]");
    if (textarea) this.#drafts.set(this.tab, textarea.value);
    this.tab = tab;
    this.limit = PAGE;
    if (textarea) textarea.value = this.#drafts.get(tab) ?? "";
    return this.refresh({ scrollBottom: true });
  }

  /** Partner ids for the tab bar: everybody I have a conversation with, plus picker-opened ones. */
  #partners(all) {
    const ids = new Set(this.extra);
    for (const m of all) for (const id of partnersOf(m)) ids.add(id);
    return [...ids]
      .map((id) => game.users.get(id))
      .filter(Boolean)
      .sort((a, b) => Number(b.isGM) - Number(a.isGM) || a.name.localeCompare(b.name, game.i18n.lang));
  }

  #tabsHtml(partners, unread) {
    const badge = (n) => (n ? `<span class="gct-wp-badge">${n > 99 ? "99+" : n}</span>` : "");
    const tab = (id, label, n, extra = "", tip = "") =>
      `<a class="gct-wp-tab${this.tab === id ? " active" : ""}" role="tab" aria-selected="${this.tab === id}" data-action="selectTab" data-tab="${esc(id)}"${tip ? ` data-tooltip="${esc(tip)}"` : ""}>${label}${badge(n)}${extra}</a>`;
    const parts = [tab(ALL, esc(L("WhisperPanel.All")), unread.total)];
    for (const u of partners) {
      const dot = `<span class="gct-wp-dot${u.active ? " on" : ""}"></span>`;
      const close = this.extra.has(u.id) ? `<span class="gct-wp-close" data-action="closeTab" data-tab="${esc(u.id)}">×</span>` : "";
      parts.push(tab(u.id, `${dot}${esc(u.name)}${u.isGM ? ` <em>GM</em>` : ""}`, unread[u.id] ?? 0, close, u.name));
    }
    const shown = new Set(partners.map((u) => u.id));
    const pickable = game.users
      .filter((u) => canWhisperTo(u) && !shown.has(u.id))
      .sort((a, b) => Number(b.isGM) - Number(a.isGM) || a.name.localeCompare(b.name, game.i18n.lang));
    if (pickable.length) {
      parts.push(`<select class="gct-wp-new" aria-label="${esc(L("WhisperPanel.NewConversation"))}"><option value="">＋ ${esc(L("WhisperPanel.NewConversation"))}</option>${pickable
        .map((u) => `<option value="${esc(u.id)}">${esc(u.name)}${u.isGM ? " (GM)" : ""}</option>`)
        .join("")}</select>`);
    }
    return parts.join("");
  }

  async #messageHtml(m) {
    const cached = this.#html.get(m.id);
    if (cached && cached.content === m.content && cached.flavor === m.flavor) return cached.html;
    let html;
    try {
      html = await renderMessageContent(m);
    } catch {
      html = m.content ?? "";
    }
    // The chitchat render hook wraps the text with the name; the panel header already shows it.
    if (isChitchat(m)) html = stripChitchatMarkup(html);
    this.#html.set(m.id, { content: m.content, flavor: m.flavor, html });
    return html;
  }

  async #itemHtml(m) {
    const author = m.author;
    const mine = author?.isSelf;
    const alias = m.alias ?? author?.name ?? "?";
    const who = alias && author?.name && alias !== author.name ? `${esc(alias)} <span class="gct-wp-user">(${esc(author.name)})</span>` : esc(alias);
    const to = intendedRecipients(m)
      .map((id) => game.users.get(id)?.name)
      .filter(Boolean);
    const color = userColor(author);
    return `<li class="gct-panel-item gct-wp-item${mine ? " mine" : ""}${m.blind ? " blind" : ""}" data-message-id="${esc(m.id)}">
      <header><strong class="gct-panel-author"${color ? ` style="color:${esc(color)}"` : ""}>${who}</strong>
        <span class="gct-wp-to">→ ${esc(to.join(", "))}</span>
        <time data-tooltip="${esc(fmtDateTime(m.timestamp))}">${esc(shortTime(m.timestamp))}</time></header>
      ${m.flavor ? `<div class="gct-wp-flavor">${m.flavor}</div>` : ""}
      <div class="gct-panel-text gct-wp-content">${await this.#messageHtml(m)}</div>
    </li>`;
  }

  /**
   * Redraw tabs, the visible page of messages and the composer state. `older` keeps the view anchored while
   * a page is prepended; otherwise the list sticks to the bottom only when it already was there.
   */
  async refresh({ scrollBottom = false, older = false } = {}) {
    const el = this.element;
    if (!el?.querySelector(".gct-wp-tabs")) return; // frame not built yet (first render pending)
    const all = visibleWhispers();
    const partners = this.#partners(all);
    if (this.tab !== ALL && !partners.some((u) => u.id === this.tab)) this.tab = ALL;

    if (!this.minimized) markRead(this.tab, all);
    const unread = unreadCounts(all);
    el.querySelector(".gct-wp-tabs").innerHTML = this.#tabsHtml(partners, unread);

    const list = tabMessages(this.tab, all);
    const page = list.slice(-this.limit);
    const items = await Promise.all(page.map((m) => this.#itemHtml(m)));
    const log = el.querySelector(".gct-wp-log");
    const ol = el.querySelector(".gct-wp-messages");
    await keepScroll(
      log,
      () => {
        ol.innerHTML = items.length ? items.join("") : `<li class="gct-panel-empty">${esc(L("WhisperPanel.Empty"))}</li>`;
      },
      { anchorTop: older }
    );
    if (scrollBottom) log.scrollTop = log.scrollHeight;
    el.querySelector(".gct-wp-older").hidden = list.length <= page.length;

    // Composer: only on a partner tab the policy allows.
    const partner = this.tab === ALL ? null : game.users.get(this.tab);
    const allowed = !!partner && canWhisperTo(partner);
    const textarea = el.querySelector("textarea[name=whisper]");
    const sendBtn = el.querySelector("[data-action=sendWhisper]");
    textarea.disabled = !allowed;
    sendBtn.disabled = !allowed;
    textarea.placeholder = partner ? (allowed ? L("WhisperPanel.Placeholder", { name: partner.name }) : L("WhisperPanel.NotAllowed", { name: partner.name })) : L("WhisperPanel.PickPartner");
    el.querySelector(".gct-panel-hint").textContent = allowed ? L("Panel.ComposeHint") : "";
    updateWhisperButtonBadge(unread.total);
  }

  async #send() {
    if (this.#sending || this.tab === ALL) return;
    const textarea = this.element?.querySelector("textarea[name=whisper]");
    const text = textarea?.value ?? "";
    if (!text.trim()) return;
    const tab = this.tab;
    const partner = game.users.get(tab);
    if (!canWhisperTo(partner)) return ui.notifications.warn(L("WhisperPanel.NotAllowed", { name: partner?.name ?? "?" }));
    this.#sending = true;
    textarea.value = "";
    this.#drafts.delete(tab);
    const restore = () => {
      if (!textarea.value && this.tab === tab) textarea.value = text;
      else this.#drafts.set(tab, text);
    };
    try {
      const message = await sendWhisperTo(tab, text);
      if (message) this.extra.delete(tab); // a real conversation now
      else restore();
    } catch (err) {
      mod.error("whisper send failed", err);
      restore();
      ui.notifications.error(L("WhisperPanel.SendFailed", { error: err?.message ?? err }));
    } finally {
      this.#sending = false;
      textarea.focus();
    }
  }

  static #onSelectTab(event, target) {
    if (event.target.closest(".gct-wp-close")) return;
    this.selectTab(target.dataset.tab);
  }

  static #onCloseTab(event, target) {
    event.stopPropagation();
    this.extra.delete(target.dataset.tab);
    if (this.tab === target.dataset.tab) this.selectTab(ALL);
    else this.refresh();
  }

  static #onLoadOlder() {
    this.limit += PAGE;
    return this.refresh({ older: true });
  }

  static #onSend() {
    return this.#send();
  }

  /** Mark the current tab read when the window comes back from minimized. */
  async maximize(...args) {
    const result = await super.maximize(...args);
    this.refresh();
    return result;
  }
}

/* -------------------------------------------- */
/*  Chat controls & hooks                       */
/* -------------------------------------------- */

/** Unread count on the chat-controls button (data attribute drawn by CSS). */
export function updateWhisperButtonBadge(total = unreadCounts().total) {
  const btn = document.querySelector("#chat-controls .gct-open-whispers");
  if (!btn) return;
  if (total > 0) btn.dataset.unread = total > 99 ? "99+" : String(total);
  else delete btn.dataset.unread;
}

/** The button on the module's chat-controls row (idempotent). */
export function injectWhisperPanelButton() {
  addToolsButton({ cls: "gct-open-whispers", icon: "fa-solid fa-comments", label: L("WhisperPanel.Title"), onClick: () => WhisperPanel.toggle() });
  updateWhisperButtonBadge();
}

const refreshAll = debounce(() => {
  const app = WhisperPanel.instance;
  if (app?.rendered) app.refresh();
  else updateWhisperButtonBadge();
}, 100);

export function registerWhisperPanelHooks() {
  const touches = (m, changes) => !!(m?.whisper?.length || "whisper" in (changes ?? {}));
  Hooks.on("createChatMessage", (m) => {
    if (m.whisper?.length) refreshAll();
  });
  Hooks.on("updateChatMessage", (m, changes) => {
    if (touches(m, changes)) refreshAll();
  });
  Hooks.on("deleteChatMessage", (m) => {
    if (m.whisper?.length) refreshAll();
  });
  Hooks.on("userConnected", () => refreshAll());
  Hooks.once("ready", () => updateWhisperButtonBadge());
}
