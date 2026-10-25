import { TEMPLATES, L } from "./constants.js";
import { formDialog, htmlRoot, metadataButton, pushMessageContextOption, readForm, renderTemplate } from "./lib.js";
import { setting } from "./settings.js";
import { portraitFlagUpdate } from "./portrait.js";
import { isChitchat } from "./chitchat.js";
import { markupToRuby, rubyToMarkup } from "./ruby.js";
import { toLocalInput, setMessageTimestamp } from "./reorder.js";

/** Can the current user edit this message (content / speaker / flavor)? */
export function canEdit(message) {
  if (!message) return false;
  if (game.user.isGM) return true;
  if (!setting("playerEdit")) return false;
  return message.canUserModify(game.user, "update");
}

/** Can the current user delete this message? */
export function canDelete(message) {
  if (!message) return false;
  if (game.user.isGM) return true;
  if (!setting("playerEdit")) return false;
  return message.canUserModify(game.user, "delete");
}

/** Delete a message, honouring the instant-delete setting. */
export async function deleteMessage(message) {
  if (!canDelete(message)) return;
  if (setting("instantDelete")) return message.delete();
  return message.deleteDialog();
}

/** Re-render every chat message currently in the DOM (after a setting that affects the header changed). gatos-lib chat. */
export { rerenderVisibleMessages } from "./lib.js";

/* -------------------------------------------- */
/*  Chat log integration                        */
/* -------------------------------------------- */

/** `<a class="gct-btn {cls}"><i class="fa-solid {icon}" inert></i></a>` with tooltip + aria-label (gatos-lib metadataButton). */
function makeButton(cls, icon, label, onClick) {
  return metadataButton({ cls: `gct-btn ${cls}`, icon: `fa-solid ${icon}`, label, onClick });
}

/** renderChatMessageHTML hook: add edit/delete buttons and make the vanilla trash icon instant. */
export function onRenderChatMessageHTML(message, html) {
  const el = htmlRoot(html);
  if (!el || !message?.id || !game.messages.has(message.id)) return;
  const meta = el.querySelector(".message-metadata");
  if (!meta || meta.querySelector(".gct-btn")) return;

  const vanillaDelete = meta.querySelector(".message-delete");
  const show = setting("showButtons");

  if (show && canEdit(message)) {
    const edit = makeButton("gct-edit", "fa-pen-to-square", L("Edit.Title"), () => openEditDialog(message));
    meta.insertBefore(edit, vanillaDelete ?? null);
  }

  if (canDelete(message)) {
    if (vanillaDelete) {
      // Capture the click before the ChatLog action handler so no confirmation dialog can appear.
      if (setting("instantDelete")) {
        vanillaDelete.addEventListener(
          "click",
          (ev) => {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            message.delete();
          },
          { capture: true }
        );
      }
    } else if (show) {
      meta.append(makeButton("gct-delete", "fa-trash", L("Chat.DeleteNow"), () => deleteMessage(message)));
    }
  }
}

/** getChatMessageContextOptions hook: add an "Edit message" entry. */
export function onGetChatMessageContextOptions(app, options) {
  pushMessageContextOption(options, {
    name: "GCT.Edit.Title",
    icon: '<i class="fa-solid fa-pen-to-square"></i>',
    condition: (message) => canEdit(message),
    callback: (message) => openEditDialog(message),
  });
}

/* -------------------------------------------- */
/*  Edit dialog                                 */
/* -------------------------------------------- */

/** Open the edit dialog for a message: speaker actor, alias, flavor and content. */
export async function openEditDialog(message) {
  if (!canEdit(message)) return ui.notifications.warn(L("Edit.NoPermission"));

  const speaker = message.speaker ?? {};
  const currentActor = ChatMessage.getSpeakerActor(speaker);
  const currentActorId = currentActor?.id ?? speaker.actor ?? "";
  const actors = game.actors
    .filter((a) => game.user.isGM || a.isOwner)
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  if (currentActor && !actors.includes(currentActor)) actors.unshift(currentActor);

  const defaultAlias = currentActor?.name ?? message.author?.name ?? "";
  const alias = speaker.alias && speaker.alias !== defaultAlias ? speaker.alias : "";

  const chitchat = isChitchat(message);
  const content = await renderTemplate(TEMPLATES.edit, {
    chitchat,
    isGM: game.user.isGM,
    timestamp: toLocalInput(message.timestamp),
    content: rubyToMarkup(message.content ?? ""),
    flavor: message.flavor ?? "",
    alias,
    noActor: !currentActorId,
    actors: actors.map((a) => ({ id: a.id, name: a.name, selected: a.id === currentActorId })),
  });

  // gatos-lib formDialog: Save (default, reads the form) / Cancel; null when cancelled or closed.
  const result = await formDialog({
    title: L("Edit.Title"),
    icon: "fa-solid fa-pen-to-square",
    classes: ["gct-edit-dialog"],
    width: 560,
    content,
    ok: { action: "save", label: L("Save"), icon: "fa-solid fa-floppy-disk", read: (button) => readForm(button) },
    cancel: { label: L("Cancel") },
  });
  if (!result) return;

  const update = {};
  const newContent = markupToRuby(result.content ?? "");
  if (newContent !== (message.content ?? "")) update.content = newContent;
  const newFlavor = (result.flavor ?? "").trim();
  if (newFlavor !== (message.flavor ?? "")) update.flavor = newFlavor;

  const newActorId = result.actorId ?? "";
  const newAlias = (result.alias ?? "").trim();
  if (!chitchat && (newActorId !== currentActorId || newAlias !== alias)) {
    update.speaker = buildSpeaker(newActorId, newAlias, message);
    Object.assign(update, portraitFlagUpdate(update.speaker));
    // OOC messages always display the author's name; switch to IC when an actor is chosen.
    if (newActorId && message.style === CONST.CHAT_MESSAGE_STYLES.OOC) update.style = CONST.CHAT_MESSAGE_STYLES.IC;
  }

  // GM: a changed send time moves the message (compared at the input's one-second resolution).
  let newTimestamp = null;
  if (game.user.isGM && result.timestamp && result.timestamp !== toLocalInput(message.timestamp)) {
    const ts = new Date(result.timestamp).getTime();
    if (Number.isFinite(ts)) newTimestamp = ts;
  }

  if (foundry.utils.isEmpty(update) && newTimestamp === null) return;
  if (!foundry.utils.isEmpty(update)) await message.update(update);
  if (newTimestamp !== null) await setMessageTimestamp(message, newTimestamp);
  ui.notifications.info(L("Edit.Saved"));
}

/** Build a full speaker object for an actor id (or none) with an optional alias override. */
function buildSpeaker(actorId, alias, message) {
  const actor = actorId ? game.actors.get(actorId) : null;
  if (actor) {
    const s = ChatMessage.getSpeaker({ actor, alias: alias || actor.name });
    return { scene: s.scene ?? null, actor: s.actor ?? actor.id, token: s.token ?? null, alias: s.alias };
  }
  const userName = message.author?.name ?? game.user.name;
  return { scene: null, actor: null, token: null, alias: alias || userName };
}
