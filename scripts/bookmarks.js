import { MODULE_ID, L, mod } from "./constants.js";
import { htmlRoot, metadataButton, pushMessageContextOption, userFlagStore } from "./lib.js";

/* -------------------------------------------- */
/*  Personal bookmarks (user flag, by message id) */
/* -------------------------------------------- */

/** {messageId: timestamp-when-bookmarked} for the current user (gatos-lib user flag store). */
export const bookmarkStore = userFlagStore(mod, "bookmarks", { default: {} });

/** {messageId: timestamp-when-bookmarked} for the current user. Ids stay valid inside archives. */
export function getBookmarks() {
  return bookmarkStore.get();
}

export const isBookmarked = (id) => !!id && !!getBookmarks()[id];

/** Add or remove several bookmarks at once. */
export async function setBookmarks(ids, on) {
  ids = [...new Set(ids)].filter(Boolean);
  if (!ids.length) return;
  const update = {};
  for (const id of ids) {
    if (on) update[`${mod.flagKey("bookmarks")}.${id}`] = Date.now();
    else update[`${mod.flagKey("bookmarks")}.-=${id}`] = null;
  }
  await game.user.update(update);
  for (const id of ids) {
    const m = game.messages.get(id);
    if (m) ui.chat?.updateMessage(m);
  }
  Hooks.callAll("gctBookmarksChanged", ids, on);
}

export const toggleBookmark = (id) => setBookmarks([id], !isBookmarked(id));

/* -------------------------------------------- */
/*  Shared highlight (message flag)             */
/* -------------------------------------------- */

/** Works for documents and serialized archive entries. */
export const isHighlighted = (m) => !!(m?.flags?.[MODULE_ID]?.highlight ?? m?.highlight);

export const canHighlight = (message) => !!message && (game.user.isGM || message.isAuthor);

export async function toggleHighlight(message) {
  if (!canHighlight(message)) return;
  if (isHighlighted(message)) await message.unsetFlag(MODULE_ID, "highlight");
  else await message.setFlag(MODULE_ID, "highlight", true);
}

/* -------------------------------------------- */
/*  Chat log integration                        */
/* -------------------------------------------- */

export function onRenderChatMessageBookmark(message, html) {
  const li = htmlRoot(html);
  if (!li || !message?.id) return;
  li.classList.toggle("gct-highlighted", isHighlighted(message));
  const marked = isBookmarked(message.id);
  li.classList.toggle("gct-bookmarked", marked);
  if (!marked) return;
  const meta = li.querySelector(".message-metadata");
  if (!meta || meta.querySelector(".gct-bookmark-icon")) return;
  meta.prepend(metadataButton({ cls: "gct-bookmark-icon", icon: "fa-solid fa-star", label: L("Bookmark.Remove"), onClick: () => toggleBookmark(message.id) }));
}

export function onGetChatMessageContextOptionsBookmark(app, options) {
  pushMessageContextOption(options, { name: "GCT.Bookmark.Add", icon: '<i class="fa-regular fa-star"></i>', condition: (m) => !isBookmarked(m.id), callback: (m) => setBookmarks([m.id], true) });
  pushMessageContextOption(options, { name: "GCT.Bookmark.Remove", icon: '<i class="fa-solid fa-star"></i>', condition: (m) => isBookmarked(m.id), callback: (m) => setBookmarks([m.id], false) });
  pushMessageContextOption(options, { name: "GCT.Highlight.Add", icon: '<i class="fa-solid fa-highlighter"></i>', condition: (m) => canHighlight(m) && !isHighlighted(m), callback: (m) => toggleHighlight(m) });
  pushMessageContextOption(options, { name: "GCT.Highlight.Remove", icon: '<i class="fa-solid fa-eraser"></i>', condition: (m) => canHighlight(m) && isHighlighted(m), callback: (m) => toggleHighlight(m) });
}
