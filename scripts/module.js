import { MODULE_ID, TEMPLATES, PARTIALS, mod } from "./constants.js";
import { htmlRoot, libActive, onChatUiRender, onSettingChanged } from "./lib.js";
import { registerSettings } from "./settings.js";
import { onRenderChatMessageHTML, onGetChatMessageContextOptions, openEditDialog, deleteMessage } from "./edit.js";
import { saveArchive, getIndex, loadArchive, collectMessages, serializeMessage, deleteMessagesInRange, resolveRange, renderMessageContent, ARCHIVE_VERSION, importArchiveFile, mergeArchives, downloadArchiveJson, removeArchive, clearArchiveFile } from "./archive.js";
import { toText, toMarkdown, exportMarkdown, exportJournal, diceDetails, toHTML, exportText, exportSingleHtml, exportZip, exportToDirectory, openInWindow, clearExportDirectory, renderDocument, htmlToText, buildBundle, absoluteUrl, EXPORT_CSS } from "./export.js";
import { openExportDialog } from "./export-dialog.js";
import { registerViewerAction } from "./viewer-actions.js";
import { ChatArchiveViewer, openSaveDialog, openDeleteDialog, injectChatButton, onBookmarksChanged, onChatMessageCountChanged } from "./viewer.js";
import { getSession, startSession, endSession, openStartSessionDialog, openEndSessionDialog, scheduleAutoArchive, onReadyAutoArchive, autoArchiveByCount } from "./session.js";
import { bookmarkStore, getBookmarks, setBookmarks, toggleBookmark, isHighlighted, toggleHighlight, onRenderChatMessageBookmark, onGetChatMessageContextOptionsBookmark } from "./bookmarks.js";
import { moveMessage, duplicateMessage, setMessageTimestamp, resortMessages, onUpdateChatMessageOrder, onCreateChatMessageOrder, onGetChatMessageContextOptionsReorder } from "./reorder.js";
import { onRenderChatMessagePortrait, onPreCreateChatMessage, portraitFor, refreshPortraits, lookupPortrait, registerPortraitProvider } from "./portrait.js";
import { onChatMessage, onRenderChatMessageChitchat, applyChitchatCssVars, matchChitchat, isChitchat } from "./chitchat.js";
import { scheduleRegroup, regroupAll } from "./grouping.js";
import { applyChatTheme } from "./chat-theme.js";
import { markupToRuby, rubyToMarkup, onPreCreateChatMessageRuby, onPreUpdateChatMessageRuby } from "./ruby.js";
import { registerChatImagesCompat } from "./compat-chat-images.js";
import { registerImageHooks, imagesApi } from "./images.js";
import { onChatMessageWhisper, registerWhisperHooks, getWhisperTarget, setWhisperTarget, clearWhisperTarget, openWhisperDialog, resolveRecipients, tokenOwners, sendWithTarget } from "./whisper.js";
import { registerTokenHudHooks, showTokenHud, hideTokenHud } from "./token-hud.js";
import { registerSpeakerBarHooks, onPreCreateChatMessage as onPreCreateSpeakerOverride, resolveCurrentSpeaker, getLockedSpeaker, updateSpeakerBar } from "./speaker-bar.js";
import { socket } from "./socket.js";
import { registerChatInputCapture } from "./chat-input.js";
import { registerTypingHooks, typingApi } from "./typing.js";
import { onPreCreateChatMessageFontStyle, onPreUpdateChatMessageFontStyle, injectFontStyleButton, fontStylesApi } from "./font-styles.js";
import { applyKoreanWebFonts } from "./fonts.js";
import { populateFontFamilyChoices } from "./chat-theme.js";
import { NotesPanel, onRenderChatMessageNote, injectNotesButton, registerNotesHooks, createNote, getNotes, notesAsText, exportNotesToJournal } from "./notes.js";
import { WhisperPanel, injectWhisperPanelButton, registerWhisperPanelHooks, sendWhisperTo } from "./whisper-panel.js";

Hooks.once("init", () => {
  // Installed-but-disabled library = "half state" (gatos-lib PLAN §5.6): code imports fine, but the library's
  // lang/css/api are missing. Foundry blocks activation when the library is missing entirely (relationships.requires).
  if (!libActive()) {
    Hooks.once("ready", () =>
      ui.notifications.error("Gato's Chat Tools: gatos-lib 모듈을 활성화해야 합니다. / Enable the gatos-lib module.", { permanent: true }),
    );
  }

  registerSettings();
  mod.preloadTemplates(Object.values(TEMPLATES), PARTIALS);
  applyChitchatCssVars();
  applyChatTheme();
  applyKoreanWebFonts();

  game.keybindings.register(MODULE_ID, "openWhisper", {
    name: "GCT.Whisper.Title",
    editable: [],
    onDown: () => {
      openWhisperDialog();
      return true;
    },
  });

  game.keybindings.register(MODULE_ID, "openNotes", {
    name: "GCT.Notes.Title",
    editable: [],
    onDown: () => {
      NotesPanel.toggle();
      return true;
    },
  });

  game.keybindings.register(MODULE_ID, "openWhispers", {
    name: "GCT.WhisperPanel.Title",
    editable: [],
    onDown: () => {
      WhisperPanel.toggle();
      return true;
    },
  });

  game.keybindings.register(MODULE_ID, "openViewer", {
    name: "GCT.Chat.OpenViewer",
    editable: [],
    onDown: () => {
      ChatArchiveViewer.open();
      return true;
    },
  });

  mod.exposeApi({
    images: imagesApi,
    openViewer: () => ChatArchiveViewer.open(),
    openSaveDialog,
    openDeleteDialog,
    openExportDialog,
    // sessions & automatic archiving
    getSession,
    startSession,
    endSession,
    openStartSessionDialog,
    openEndSessionDialog,
    autoArchiveByCount,
    // bookmarks & highlights
    getBookmarks,
    setBookmarks,
    toggleBookmark,
    isHighlighted,
    toggleHighlight,
    // order
    moveMessage,
    duplicateMessage,
    setMessageTimestamp,
    resortMessages,
    // archive files
    importArchiveFile,
    mergeArchives,
    downloadArchiveJson,
    removeArchive,
    clearArchiveFile,
    // extra export formats
    toMarkdown,
    exportMarkdown,
    exportJournal,
    diceDetails,
    deleteMessagesInRange,
    resolveRange,
    openEditDialog,
    deleteMessage,
    saveArchive,
    getIndex,
    loadArchive,
    collectMessages,
    serializeMessage,
    renderMessageContent,
    ARCHIVE_VERSION,
    portraitFor,
    lookupPortrait,
    registerPortraitProvider,
    refreshPortraits,
    matchChitchat,
    isChitchat,
    markupToRuby,
    rubyToMarkup,
    regroupAll,
    resolveCurrentSpeaker,
    getLockedSpeaker,
    updateSpeakerBar,
    toText,
    toHTML,
    htmlToText,
    renderDocument,
    buildBundle,
    absoluteUrl,
    EXPORT_CSS,
    exportText,
    exportSingleHtml,
    exportZip,
    exportToDirectory,
    openInWindow,
    clearExportDirectory,
    // extension: extra viewer buttons
    registerViewerAction,
    // whisper targets
    whisper: { getWhisperTarget, setWhisperTarget, clearWhisperTarget, openWhisperDialog, resolveRecipients, tokenOwners, sendWithTarget, showTokenHud, hideTokenHud, sendWhisperTo },
    // typing indicator console helpers: typing.status(), typing.test()
    typing: typingApi,
    // inline font styles {@name text}
    fontStyles: fontStylesApi,
    // floating panels
    panels: {
      notes: () => NotesPanel.open(),
      whispers: (userId = null) => WhisperPanel.openTo(userId),
    },
    notes: { create: createNote, list: getNotes, asText: notesAsText, exportJournal: exportNotesToJournal },
  });
});

Hooks.once("ready", () => {
  socket.init();
  populateFontFamilyChoices(); // Foundry's fonts are loaded by now
});

// Chat input edits (delegated `input` listener on the v13 #chat-message textarea), before the chat log builds its input.
registerChatInputCapture();

// Message creation: speaker lock first, then freeze the portrait of the final speaker.
registerChatImagesCompat();
registerImageHooks(); // before chitchat's chatMessage hook

Hooks.on("chatMessage", onChatMessageWhisper); // before chitchat, which copies chatData.whisper
Hooks.on("chatMessage", onChatMessage);
registerWhisperHooks();
registerTokenHudHooks();
Hooks.on("preCreateChatMessage", onPreCreateSpeakerOverride);
Hooks.on("preCreateChatMessage", onPreCreateChatMessage);
Hooks.on("preCreateChatMessage", onPreCreateChatMessageFontStyle);
Hooks.on("preCreateChatMessage", onPreCreateChatMessageRuby);
Hooks.on("preUpdateChatMessage", onPreUpdateChatMessageFontStyle);
Hooks.on("preUpdateChatMessage", onPreUpdateChatMessageRuby);

// Message rendering: notes hidden first, chitchat markup, portrait, edit/delete buttons, then grouping once inserted.
Hooks.on("renderChatMessageHTML", onRenderChatMessageNote);
Hooks.on("renderChatMessageHTML", onRenderChatMessageChitchat);
Hooks.on("renderChatMessageHTML", onRenderChatMessagePortrait);
Hooks.on("renderChatMessageHTML", onRenderChatMessageHTML);
Hooks.on("renderChatMessageHTML", onRenderChatMessageBookmark);
Hooks.on("renderChatMessageHTML", onRenderChatMessageMarker);
Hooks.on("renderChatMessageHTML", () => scheduleRegroup());
Hooks.on("deleteChatMessage", () => scheduleRegroup(200));
Hooks.on("renderChatLog", () => scheduleRegroup(100));

Hooks.on("getChatMessageContextOptions", onGetChatMessageContextOptions);
Hooks.on("getChatMessageContextOptions", onGetChatMessageContextOptionsBookmark);
Hooks.on("getChatMessageContextOptions", onGetChatMessageContextOptionsReorder);

// Order (moved / duplicated messages) and automatic archiving.
Hooks.on("updateChatMessage", onUpdateChatMessageOrder);
Hooks.on("createChatMessage", onCreateChatMessageOrder);
Hooks.on("createChatMessage", () => scheduleAutoArchive());
Hooks.on("createChatMessage", () => onChatMessageCountChanged());
Hooks.on("deleteChatMessage", () => onChatMessageCountChanged());
Hooks.once("ready", () => onReadyAutoArchive());
Hooks.on("gctBookmarksChanged", onBookmarksChanged);
// The user's bookmark flag changed from elsewhere (another window, the chat context menu).
bookmarkStore.watch(() => onBookmarksChanged());
// renderChatInput + renderChatLog, in that order (no collapseSidebar: the input re-renders anyway).
onChatUiRender(
  () => {
    injectChatButton();
    injectNotesButton();
    injectWhisperPanelButton();
    injectFontStyleButton();
  },
  { deferCollapse: false }
);
registerNotesHooks();
registerWhisperPanelHooks();
// Re-render the viewer when the archive index or the session changes on any client.
onSettingChanged(mod, ["archiveIndex", "session"], () => {
  const viewer = ChatArchiveViewer.instance;
  if (viewer?.rendered) viewer.render();
});
// Korean web fonts toggled: the chat font choices follow. Whisper policy: the panel's picker and composer follow.
onSettingChanged(mod, "koreanWebFonts", () => populateFontFamilyChoices());
onSettingChanged(mod, "whisperPanelPolicy", () => WhisperPanel.instance?.refresh());
Hooks.on("gctArchiveSaved", () => {
  const viewer = ChatArchiveViewer.instance;
  if (viewer?.rendered) viewer.render();
});
Hooks.on("gctViewerActionsChanged", () => {
  const viewer = ChatArchiveViewer.instance;
  if (viewer?.rendered) viewer.render();
});

/** Session start/end cards: compact centred style, no edit buttons needed. */
function onRenderChatMessageMarker(message, html) {
  const li = htmlRoot(html);
  if (li && message?.flags?.[MODULE_ID]?.sessionMarker) li.classList.add("gct-marker");
}

registerSpeakerBarHooks();
// After the speaker / whisper bars so the typing line is mounted on top of them.
registerTypingHooks();
