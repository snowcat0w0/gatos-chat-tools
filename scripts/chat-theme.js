import { setting } from "./settings.js";

/** Theme presets: message background and text colour (borders and whisper/blind tints are derived in CSS). */
export const CHAT_THEMES = {
  light: { bg: "#f7f5f0", text: "#1f1f1f" },
  dark: { bg: "#23262f", text: "#e6e6e6" },
  sepia: { bg: "#efe2c6", text: "#3b2f1e" },
};

/** Font size choices: 0 = leave the system's size alone. */
export const CHAT_FONT_SIZES = [0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24];

/** ColorField values come back as Color instances (or null); return a CSS string or the fallback. */
function cssColor(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return foundry.utils.Color.from(value).css;
  } catch {
    return fallback;
  }
}

/** The effective { bg, text } of this client's chat theme, or null for the system default. */
export function chatThemeColors() {
  const theme = setting("chatTheme");
  if (theme === "custom") {
    return {
      bg: cssColor(setting("chatBgColor"), CHAT_THEMES.light.bg),
      text: cssColor(setting("chatTextColor"), CHAT_THEMES.light.text),
    };
  }
  return CHAT_THEMES[theme] ?? null;
}

/** Apply this client's chat theme and base font size as classes + CSS variables on the document. */
export function applyChatTheme() {
  const root = document.documentElement;
  const colors = chatThemeColors();
  root.classList.toggle("gct-chat-themed", !!colors);
  if (colors) {
    root.style.setProperty("--gct-chat-bg", colors.bg);
    root.style.setProperty("--gct-chat-text", colors.text);
  } else {
    root.style.removeProperty("--gct-chat-bg");
    root.style.removeProperty("--gct-chat-text");
  }

  const size = Number(setting("chatFontSize")) || 0;
  root.classList.toggle("gct-chat-font", size > 0);
  if (size > 0) root.style.setProperty("--gct-chat-font-size", `${size}px`);
  else root.style.removeProperty("--gct-chat-font-size");
}
