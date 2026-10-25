import { MODULE_ID, TEMPLATES, L, mod } from "./constants.js";
import { formDialog, readForm, renderTemplate } from "./lib.js";
import { setting } from "./settings.js";
import { exportText, exportMarkdown, exportJournal, exportSingleHtml, exportZip, exportToDirectory, openInWindow, isDirectoryPickerSupported, clearExportDirectory } from "./export.js";

/** Apply the dialog's content filters to a serialized message list. */
export function filterForExport(messages, { chitchat = true, whispers = true } = {}) {
  return messages.filter((m) => {
    if (!chitchat && m.chitchat) return false;
    if (!whispers && (m.whisper?.length || m.blind)) return false;
    return true;
  });
}

/**
 * Open the export dialog for a list of serialized messages.
 * @param {object} opts
 * @param {object[]} opts.messages        Messages to export (already filtered by the viewer).
 * @param {string} [opts.title]
 * @param {string} [opts.source]
 * @param {boolean} [opts.includeChitchat=true]  Initial state of the chitchat checkbox.
 * @returns {Promise<string|null>} The mode that ran, or null when cancelled.
 */
export async function openExportDialog({ messages, title, source, includeChitchat = true } = {}) {
  const modes = [
    { value: "txt", label: L("ExportDialog.ModeTxt"), hint: L("ExportDialog.ModeTxtHint") },
    { value: "md", label: L("ExportDialog.ModeMd"), hint: L("ExportDialog.ModeMdHint") },
    { value: "html", label: L("ExportDialog.ModeHtml"), hint: L("ExportDialog.ModeHtmlHint") },
    { value: "zip", label: L("ExportDialog.ModeZip"), hint: L("ExportDialog.ModeZipHint") },
    ...(isDirectoryPickerSupported() ? [{ value: "dir", label: L("ExportDialog.ModeDir"), hint: L("ExportDialog.ModeDirHint") }] : []),
    { value: "window", label: L("ExportDialog.ModeWindow"), hint: L("ExportDialog.ModeWindowHint") },
    ...(game.user.can("JOURNAL_CREATE") ? [{ value: "journal", label: L("ExportDialog.ModeJournal"), hint: L("ExportDialog.ModeJournalHint") }] : []),
  ];
  let last = setting("lastExportMode");
  if (!modes.some((m) => m.value === last)) last = "html";
  modes.forEach((m) => (m.checked = m.value === last));

  const hasWhispers = messages.some((m) => m.whisper?.length || m.blind);
  const hasChitchat = messages.some((m) => m.chitchat);

  const content = await renderTemplate(TEMPLATES.export, {
    modes,
    includeChitchat,
    hasChitchat,
    hasWhispers,
    dirSupported: isDirectoryPickerSupported(),
    count: messages.length,
  });

  const countOf = (fd) => filterForExport(messages, { chitchat: !!fd.chitchat, whispers: !!fd.whispers }).length;

  // gatos-lib formDialog: the export button's callback returns the mode that ran (or "cancel" on failure).
  const result = await formDialog({
    title: L("ExportDialog.Title"),
    icon: "fa-solid fa-file-export",
    classes: ["gct-export-dialog"],
    width: 500,
    content,
    render: (event, dialog) => {
      const root = dialog?.element ?? document;
      const form = root.querySelector?.("form.dialog-form, form") ?? root;
      const update = () => {
        const fd = readForm(form);
        form.querySelectorAll(".gct-mode-hint").forEach((el) => (el.hidden = el.dataset.mode !== fd.mode));
        form.querySelectorAll(".gct-mode-opt").forEach((el) => (el.hidden = !el.dataset.modes.split(",").includes(fd.mode)));
        const c = form.querySelector(".gct-export-count");
        if (c) c.textContent = countOf(fd);
      };
      form.addEventListener("change", update);
      form.querySelector(".gct-dir-reset")?.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await clearExportDirectory();
        ui.notifications.info(L("ExportDialog.DirReset"));
      });
      update();
    },
    ok: {
      action: "export",
      label: L("ExportDialog.Run"),
      icon: "fa-solid fa-file-export",
      callback: async (event, button) => {
        // Run inside the click handler so folder/window modes keep the user gesture.
        const fd = readForm(button.form);
        const selected = filterForExport(messages, { chitchat: !!fd.chitchat, whispers: !!fd.whispers });
        const meta = { title, source, portraits: !!fd.portraits, userColors: !!fd.userColors, diceDetails: !!fd.diceDetails };
        await game.settings.set(MODULE_ID, "lastExportMode", fd.mode);
        if (!selected.length) {
          ui.notifications.warn(L("Viewer.NothingToExport"));
          return "cancel";
        }
        try {
          switch (fd.mode) {
            case "txt":
              exportText(selected, meta);
              break;
            case "md":
              exportMarkdown(selected, meta);
              break;
            case "journal":
              await exportJournal(selected, meta, { publicView: !!fd.journalPublic });
              break;
            case "html":
              await exportSingleHtml(selected, meta);
              break;
            case "zip":
              await exportZip(selected, meta);
              break;
            case "dir":
              await exportToDirectory(selected, meta);
              break;
            case "window":
              openInWindow(selected, meta);
              break;
          }
        } catch (err) {
          mod.error("export failed", err);
          ui.notifications.error(L("ExportDialog.Failed", { error: err.message }));
          return "cancel";
        }
        return fd.mode;
      },
    },
    cancel: { label: L("Cancel") },
  });
  return result && result !== "cancel" ? result : null;
}
