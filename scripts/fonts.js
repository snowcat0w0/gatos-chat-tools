import { setting } from "./settings.js";

/*
 * Font lists shared by inline font styles (font-styles.js) and the chat font preference (chat-theme.js):
 * Foundry's registered fonts plus a built-in pack of Korean web fonts served by Google Fonts (all SIL OFL).
 */

/** Korean Google Fonts families (SIL Open Font License), loaded by one stylesheet link when `koreanWebFonts` is on. */
export const KOREAN_WEB_FONTS = Object.freeze([
  "Nanum Myeongjo",
  "Nanum Gothic",
  "Nanum Pen Script",
  "Nanum Brush Script",
  "Gowun Batang",
  "Gowun Dodum",
  "Do Hyeon",
  "Jua",
  "Black Han Sans",
  "Song Myung",
  "Hi Melody",
  "Gaegu",
  "Gamja Flower",
  "Poor Story",
  "Stylish",
  "Yeon Sung",
  "East Sea Dokdo",
  "Dokdo",
  "Gugi",
  "Cute Font",
]);

/**
 * One Google Fonts CSS2 request for every family (regular weight; bold is synthesized). Google serves Korean
 * fonts as unicode-range slices, so a browser only downloads the glyphs a page actually uses.
 */
export const KOREAN_WEB_FONTS_URL = `https://fonts.googleapis.com/css2?${KOREAN_WEB_FONTS.map((f) => `family=${f.replace(/ /g, "+")}`).join("&")}&display=swap`;

const LINK_ID = "gct-korean-webfonts";

/** Is the Korean web font pack enabled for this world? */
export function koreanWebFontsOn() {
  try {
    return !!setting("koreanWebFonts");
  } catch {
    return false;
  }
}

/** Add or remove the Google Fonts stylesheet link on this client (init and on setting change). */
export function applyKoreanWebFonts() {
  const existing = document.getElementById(LINK_ID);
  if (!koreanWebFontsOn()) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const link = document.createElement("link");
  link.id = LINK_ID;
  link.rel = "stylesheet";
  link.href = KOREAN_WEB_FONTS_URL;
  link.referrerPolicy = "no-referrer";
  document.head.append(link);
}

/**
 * Fonts Foundry offers in its editors: the loaded ones (FontConfig.getAvailableFonts) plus every editor font
 * definition from CONFIG and the core "fonts" setting (in case loading had not finished yet).
 * @returns {string[]}
 */
export function foundryFonts() {
  const FontConfig = foundry.applications?.settings?.menus?.FontConfig;
  const set = new Set();
  try {
    for (const f of FontConfig?.getAvailableFonts?.() ?? []) set.add(f);
  } catch {
    /* ignore */
  }
  const defs = [CONFIG.fontDefinitions ?? {}];
  try {
    defs.push(game.settings.get("core", FontConfig?.SETTING ?? "fonts") ?? {});
  } catch {
    /* ignore */
  }
  for (const group of defs) for (const [family, def] of Object.entries(group ?? {})) if (def?.editor) set.add(family);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Font groups for pickers: [{ id, fonts: string[] }], Korean web fonts only when enabled. */
export function fontGroups() {
  const groups = [{ id: "foundry", fonts: foundryFonts() }];
  if (koreanWebFontsOn()) groups.push({ id: "korean", fonts: [...KOREAN_WEB_FONTS] });
  return groups.filter((g) => g.fonts.length);
}

/** Every font name offered by fontGroups(). */
export function allFontNames() {
  return [...new Set(fontGroups().flatMap((g) => g.fonts))];
}
