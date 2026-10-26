import { MODULE_ID, mod } from "./constants.js";
import { refreshPortraits } from "./portrait.js";
import { rerenderVisibleMessages } from "./edit.js";
import { regroupAll } from "./grouping.js";
import { applyChitchatCssVars } from "./chitchat.js";
import { mountSpeakerBar, updateSpeakerBar } from "./speaker-bar.js";
import { applyChatTheme, CHAT_FONT_SIZES } from "./chat-theme.js";

/**
 * gatos-lib settings table (same keys, order, scopes, types, defaults and onChange as 0.5.2).
 * Lang keys default to `GCT.Settings.<PascalKey>.Name` / `.Hint`; settings 0.5.2 registered without a hint
 * pass `hintKey: false`. Hidden entries are `config: false` without name/hint, as before.
 * The image settings (images.js) and the chat-images compat setting stay in their own init hooks.
 */
export function registerSettings() {
  mod.registerSettings({
    // ---- Editing / deleting
    instantDelete: { scope: "world", type: Boolean, default: true },
    playerEdit: { scope: "world", type: Boolean, default: true, onChange: () => rerenderVisibleMessages() },
    showButtons: { scope: "client", type: Boolean, default: true, onChange: () => rerenderVisibleMessages() },
    hideSecret: { scope: "world", type: Boolean, default: true },

    // ---- Portraits (client preferences)
    showPortrait: { scope: "client", type: Boolean, default: true, onChange: () => refreshPortraits() },
    portraitSize: { scope: "client", type: Number, default: 40, range: { min: 24, max: 80, step: 4 }, onChange: () => refreshPortraits() },
    portraitShape: {
      scope: "client", type: String, hintKey: false,
      choices: { square: "GCT.Settings.PortraitShape.Square", circle: "GCT.Settings.PortraitShape.Circle" },
      default: "square", onChange: () => refreshPortraits(),
    },

    // ---- Chat theme (client preferences)
    chatTheme: {
      scope: "client", type: String,
      choices: ["default", "light", "dark", "sepia", "custom"],
      default: "default", onChange: () => applyChatTheme(),
    },
    chatBgColor: { scope: "client", type: new foundry.data.fields.ColorField({ nullable: false, initial: "#f7f5f0" }), default: "#f7f5f0", onChange: () => applyChatTheme() },
    chatTextColor: { scope: "client", type: new foundry.data.fields.ColorField({ nullable: false, initial: "#1f1f1f" }), default: "#1f1f1f", onChange: () => applyChatTheme() },
    chatFontSize: {
      scope: "client", type: Number,
      choices: Object.fromEntries(CHAT_FONT_SIZES.map((n) => [n, n ? `${n}px` : "GCT.Settings.ChatFontSize.Default"])),
      default: 0, onChange: () => applyChatTheme(),
    },

    // ---- Chitchat
    chitchatTrigger: { scope: "client", type: String, default: "/p" },
    chitchatAsOOC: { scope: "world", type: Boolean, default: true },
    chitchatFontSize: { scope: "client", type: Number, default: 12, range: { min: 10, max: 20, step: 1 }, onChange: () => applyChitchatCssVars() },
    chitchatBrightness: { scope: "client", type: Number, default: 0.7, range: { min: 0, max: 1, step: 0.05 }, onChange: () => rerenderVisibleMessages() },
    chitchatLineBreak: { scope: "client", type: Boolean, default: false, onChange: () => rerenderVisibleMessages() },

    // ---- Grouping
    groupMessages: { scope: "client", type: Boolean, default: true, onChange: () => regroupAll() },
    groupChitchat: { scope: "client", type: Boolean, default: true, onChange: () => regroupAll() },
    groupGapMinutes: { scope: "client", type: Number, default: 0, range: { min: 0, max: 120, step: 5 }, nameKey: "GCT.Settings.GroupGap.Name", hintKey: "GCT.Settings.GroupGap.Hint", onChange: () => regroupAll() },

    // ---- Speaker bar
    speakerBar: { scope: "client", type: Boolean, default: true, onChange: () => mountSpeakerBar() },
    speakerFavorites: { scope: "client", type: Boolean, default: true, onChange: () => updateSpeakerBar() },
    favoriteChipMode: {
      scope: "client", type: String, hintKey: false,
      choices: { portrait: "GCT.Settings.FavoriteChipMode.Portrait", name: "GCT.Settings.FavoriteChipMode.NameChoice" },
      default: "portrait", onChange: () => updateSpeakerBar(),
    },

    // ---- Sessions & automatic archiving
    sessionAnnounce: { scope: "world", type: Boolean, default: true },
    autoArchiveThreshold: { scope: "world", type: Number, default: 0, range: { min: 0, max: 5000, step: 100 }, nameKey: "GCT.Settings.AutoThreshold.Name", hintKey: "GCT.Settings.AutoThreshold.Hint" },
    autoArchiveKeep: { scope: "world", type: Number, default: 50, range: { min: 0, max: 1000, step: 10 }, nameKey: "GCT.Settings.AutoKeep.Name", hintKey: "GCT.Settings.AutoKeep.Hint" },
    autoArchiveOnLoad: { scope: "world", type: Boolean, default: false, nameKey: "GCT.Settings.AutoOnLoad.Name", hintKey: "GCT.Settings.AutoOnLoad.Hint" },
    // The running (or last) session: { active, number, title, startedAt }
    session: { hidden: true, scope: "world", type: Object, default: { active: false, number: 0 } },

    // ---- Token menu (whisper to token owners)
    tokenHud: { scope: "client", type: Boolean, default: true },

    // ---- Hidden state
    viewerIncludeChitchat: { hidden: true, scope: "client", type: Boolean, default: true },
    lastExportMode: { hidden: true, scope: "client", type: String, default: "html" },
    // Archive index: { list: [{ id, name, path, createdAt, createdBy, from, to, count }] }
    archiveIndex: { hidden: true, scope: "world", type: Object, default: { list: [] } },
    // Timestamp of the newest message included in any archive so far.
    lastArchived: { hidden: true, scope: "world", type: Number, default: 0 },
  });
}

export const setting = (key) => game.settings.get(MODULE_ID, key);
