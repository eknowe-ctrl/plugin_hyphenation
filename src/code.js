const Hypher = require("hypher");
const russianPatterns = require("hyphenation.ru");

const ZERO_WIDTH_SPACE = "\u200B";
const INSERTED_BREAK_MARKER = `-${ZERO_WIDTH_SPACE}`;
const hypher = new Hypher(russianPatterns);
// NBSP ( ) must NOT be treated as a breakable space: it should stay
// attached to adjacent word characters so "с точки" is one token.
// In JS, \s matches  , so we explicitly exclude it from the space class
// and include it in the word class via the alternation (?:[^\s]| )+.
const TOKEN_REGEX = /(\n|[^\S\n ]+|(?:[^\s]| )+)/g;
const SPACE_TOKEN_REGEX = /^[^\S\n ]+$/;
const RUSSIAN_TOKEN_REGEX = /^([^А-ЯЁа-яё-]*)([А-ЯЁа-яё]+)([^А-ЯЁа-яё-]*)$/;
const WIDTH_EPSILON = 0.01;
const SPARSE_LINE_FILL_THRESHOLD = 0.75;
// Extra justified gap per inter-word space as fraction of line width.
// Catches visually sparse lines with short words even when fill > 75%.
const SPARSE_GAP_FRACTION = 0.030;
const WIDOW_WORD_THRESHOLD = 8;
const NBSP = "\u00A0";
const AUTO_RECALC_DEBOUNCE_MS = 280;
const SELF_CHANGE_SUPPRESS_MS = 600;
const SETTINGS_STORAGE_KEY = "hyphenationSettingsV6";
const SNAPSHOT_PLUGIN_KEY = "hyphenationSnapshotV4";
const APPLY_MODE = "apply";
const RESET_MODE = "reset";
const UI_WINDOW_WIDTH = 360;
const UI_INITIAL_HEIGHT = 766;
const UI_MIN_HEIGHT = 300;
const UI_MAX_HEIGHT = 1012;


const ORPHAN_WORDS = new Set([
  "в",
  "с",
  "к",
  "у",
  "о",
  "а",
  "и",
  "я",
  "на",
  "за",
  "по",
  "от",
  "до",
  "из",
  "со",
  "не",
  "ни",
  "но",
  "да",
  "об",
  "во",
  "ко",
  "же",
  "ли",
  "бы",
  "то",
  "при",
  "для",
  "под",
  "над",
  "без",
  "или"
]);

const DEFAULT_SETTINGS = {
  autoWatch: true,
  preventOrphans: true,
  autoNbsp: true,
  optimizeLetterSpacing: true,
  minWordLengthForHyphenation: 5,
  minLettersBeforeHyphen: 2,
  minLettersAfterHyphen: 3,
  maxConsecutiveHyphens: 2,
  letterSpacingMinPercent: -1,
  letterSpacingDesiredPercent: 0,
  letterSpacingMaxPercent: 8,
  letterSpacingStepPercent: 0.5
};

let watchedNodeIds = new Set();
let watchedNodeWidths = new Map();
let autoRecalcTimer = null;
let autoRecalcInProgress = false;
let autoRecalcQueued = false;
let suppressDocumentChangeUntil = 0;
let manualActionInProgress = false;
let runtimeSettings = Object.assign({}, DEFAULT_SETTINGS);
let documentChangeWatchSupported = true;

function clampNumber(value, minValue, maxValue) {
  if (Number.isNaN(value)) {
    return minValue;
  }
  return Math.max(minValue, Math.min(maxValue, value));
}

function normalizeUiHeight(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return UI_INITIAL_HEIGHT;
  }
  return Math.round(clampNumber(parsed, UI_MIN_HEIGHT, UI_MAX_HEIGHT));
}

function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};

  const autoWatch =
    typeof src.autoWatch === "boolean" ? src.autoWatch : DEFAULT_SETTINGS.autoWatch;
  const preventOrphans =
    typeof src.preventOrphans === "boolean" ? src.preventOrphans : DEFAULT_SETTINGS.preventOrphans;
  const autoNbsp =
    typeof src.autoNbsp === "boolean" ? src.autoNbsp : DEFAULT_SETTINGS.autoNbsp;
  const optimizeLetterSpacing =
    typeof src.optimizeLetterSpacing === "boolean"
      ? src.optimizeLetterSpacing
      : DEFAULT_SETTINGS.optimizeLetterSpacing;

  const minWordLengthForHyphenation = clampNumber(
    Number(src.minWordLengthForHyphenation != null ? src.minWordLengthForHyphenation : DEFAULT_SETTINGS.minWordLengthForHyphenation),
    4, 12
  );

  const minLettersBeforeHyphen = clampNumber(
    Number(src.minLettersBeforeHyphen != null ? src.minLettersBeforeHyphen : DEFAULT_SETTINGS.minLettersBeforeHyphen),
    1, 5
  );

  const minLettersAfterHyphen = clampNumber(
    Number(src.minLettersAfterHyphen != null ? src.minLettersAfterHyphen : DEFAULT_SETTINGS.minLettersAfterHyphen),
    1, 5
  );

  const maxConsecutiveHyphens = clampNumber(
    Number(src.maxConsecutiveHyphens != null ? src.maxConsecutiveHyphens : DEFAULT_SETTINGS.maxConsecutiveHyphens),
    0, 5
  );

  const minPercent = clampNumber(
    Number(src.letterSpacingMinPercent != null ? src.letterSpacingMinPercent : DEFAULT_SETTINGS.letterSpacingMinPercent), -10, 10
  );
  const desiredPercent = clampNumber(
    Number(src.letterSpacingDesiredPercent != null ? src.letterSpacingDesiredPercent : DEFAULT_SETTINGS.letterSpacingDesiredPercent), -10, 10
  );
  const maxPercent = clampNumber(
    Number(src.letterSpacingMaxPercent != null ? src.letterSpacingMaxPercent : DEFAULT_SETTINGS.letterSpacingMaxPercent), -10, 10
  );
  const stepPercent = clampNumber(
    Number(src.letterSpacingStepPercent != null ? src.letterSpacingStepPercent : DEFAULT_SETTINGS.letterSpacingStepPercent), 0.1, 5
  );

  const sortedMin = Math.min(minPercent, maxPercent);
  const sortedMax = Math.max(minPercent, maxPercent);
  const sortedDesired = clampNumber(desiredPercent, sortedMin, sortedMax);

  return {
    autoWatch,
    preventOrphans,
    autoNbsp,
    optimizeLetterSpacing,
    minWordLengthForHyphenation,
    minLettersBeforeHyphen,
    minLettersAfterHyphen,
    maxConsecutiveHyphens,
    letterSpacingMinPercent: sortedMin,
    letterSpacingDesiredPercent: sortedDesired,
    letterSpacingMaxPercent: sortedMax,
    letterSpacingStepPercent: stepPercent
  };
}

// Derives per-node hyphenation settings from block geometry.
// Narrow columns (few characters per line) need more aggressive hyphenation and
// a wider letter-spacing range than the user's global settings may specify.
// Math.min/max ensure we only make settings MORE aggressive, never less.
function deriveSettingsForNode(node, baseSettings) {
  const fontSize = typeof node.fontSize === "number" && node.fontSize > 0
    ? node.fontSize : 16;
  // 0.55 ≈ average Russian character width as a fraction of font size.
  const charsPerLine = node.width / (fontSize * 0.55);

  if (charsPerLine >= 45) {
    return baseSettings; // wide column — user settings are fine
  }

  const s = Object.assign({}, baseSettings);

  if (charsPerLine < 30) {
    // Narrow column: hyphenate shorter words and allow tighter splits.
    // Letter spacing range is intentionally left to the user's settings.
    s.minWordLengthForHyphenation = Math.min(s.minWordLengthForHyphenation, 5);
    s.minLettersBeforeHyphen      = Math.min(s.minLettersBeforeHyphen, 2);
    s.minLettersAfterHyphen       = Math.min(s.minLettersAfterHyphen, 2);
  } else {
    // Medium column (30–44 chars): moderate tightening.
    s.minWordLengthForHyphenation = Math.min(s.minWordLengthForHyphenation, 5);
    s.minLettersAfterHyphen       = Math.min(s.minLettersAfterHyphen, 3);
  }

  return s;
}

async function loadRuntimeSettings() {
  try {
    const saved = await figma.clientStorage.getAsync(SETTINGS_STORAGE_KEY);
    if (!saved || typeof saved !== "object") {
      runtimeSettings = normalizeSettings(DEFAULT_SETTINGS);
      return;
    }
    runtimeSettings = normalizeSettings(saved);
  } catch (error) {
    console.error("Не удалось загрузить настройки плагина", error);
    runtimeSettings = normalizeSettings(DEFAULT_SETTINGS);
  }
}

async function persistRuntimeSettings() {
  try {
    await figma.clientStorage.setAsync(SETTINGS_STORAGE_KEY, runtimeSettings);
  } catch (error) {
    console.error("Не удалось сохранить настройки плагина", error);
  }
}

function normalizeTextForRehyphenation(text) {
  // Strips only plugin markers. Preserves \u00A0 so that preventRussianOrphans
  // and applyNonBreakingSpaces survive inside hyphenateRussianTextWithVisibleDash.
  return text
    .replace(/\u00AD/g, "")
    .replace(/-\u200B/g, "")
    .replace(/\u200B/g, "");
}

// Full clean: plugin markers + all NBSP -> regular spaces.
// Used for snapshots and reset so repeated Apply is idempotent
// and old snapshots (that may contain markers) are handled correctly.
function normalizeToCleanText(text) {
  return normalizeTextForRehyphenation(text).replace(/\u00A0/g, " ");
}

function resetHyphenationText(text) {
  return normalizeToCleanText(text);
}

// Patterns for automatic non-breaking spaces (longest alternatives first to
// prevent shorter ones from shadowing, e.g. "км" before "м").
const NBSP_UNITS_RE = new RegExp(
  "(\\d+(?:[,.]\\d+)?)[^\\S\\n]+" +
  "(млрд|млн|тыс" +
  "|мкг|мг|кг" +
  "|мкм|нм|пм|км|дм|см|мм" +
  "|мл|дл|кл" +
  "|га" +
  "|ТГц|ГГц|МГц|кГц|Гц" +
  "|МВт|кВт|мВт|Вт" +
  "|МВ|кВ|мВ|В" +
  "|мкА|мА|А" +
  "|МОм|кОм|Ом" +
  "|МДж|кДж|Дж|ккал|кал" +
  "|ГПа|МПа|кПа|Па|атм|бар" +
  "|мкс|нс|мс|мин" +
  "|руб|коп" +
  "|шт|ед|экз" +
  "|г|м|л|А|ч" +
  ")\\b",
  "g"
);
const NBSP_PERCENT_RE = /(\d+(?:[,.]\d+)?)[^\S\n]+([%₽€$])/g;
const NBSP_TEMP_RE = /(\d+(?:[,.]\d+)?)[^\S\n]+(°[CFK]?)/g;
const NBSP_MONTHS_RE = /(\d{1,2})[^\S\n]+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\b/gi;
const NBSP_YEAR_RE = /(\d+)[^\S\n]+(году?|год(?:а|ов)?|лет)\b/g;
const NBSP_INITIALS_RE = /([А-ЯЁA-Z])\.[^\S\n]+(?=[А-ЯЁA-Za-яёа-я])/g;
const NBSP_ADDR_RE = /\b(проф|акад|доц|тов|ул|пр|пл|пос|им|кв|оз|г|д|р|о|с)\.[^\S\n]+(?=[А-ЯЁ0-9])/gi;

function applyNonBreakingSpaces(text) {
  return text
    .replace(NBSP_MONTHS_RE,  `$1 $2`)
    .replace(NBSP_YEAR_RE,    `$1 $2`)
    .replace(NBSP_PERCENT_RE, `$1 $2`)
    .replace(NBSP_TEMP_RE,    `$1 $2`)
    .replace(NBSP_UNITS_RE,   `$1 $2`)
    .replace(NBSP_INITIALS_RE, `$1. `)
    .replace(NBSP_ADDR_RE,     `$1. `);
}

function preventRussianOrphans(text) {
  // Lookbehind (?<=...) makes the prefix non-consuming. Without it, a non-orphan
  // 3-letter word like "чем" consumes the trailing space, so the next match attempt
  // starts at "у" with no preceding space visible to the pattern — "у" is skipped.
  // Separator [^\S\n\u00A0]+ excludes NBSP: once "у" gets NBSP, the next pass
  // won't re-consume that NBSP as a separator and re-match "у" (no-op loop).
  const pattern = /(?:^|(?<=[\s(«„“”']))([\u0410-\u042F\u0401\u0430-\u044F\u0451]{1,3})[^\S\n\u00A0]+(?=[\u0410-\u042F\u0401\u0430-\u044F\u04510-9\u00AB"(\u201E])/g;
  let prev = "";
  let current = text;
  while (current !== prev) {
    prev = current;
    current = prev.replace(pattern, (match, word) => {
      if (!ORPHAN_WORDS.has(word.toLowerCase())) {
        return match;
      }
      return `${word}${NBSP}`;
    });
  }
  return current;
}

function serializeLetterSpacing(letterSpacing) {
  if (!letterSpacing || letterSpacing === figma.mixed) {
    return null;
  }
  if (letterSpacing.unit !== "PIXELS" && letterSpacing.unit !== "PERCENT") {
    return null;
  }
  if (typeof letterSpacing.value !== "number") {
    return null;
  }
  return {
    unit: letterSpacing.unit,
    value: letterSpacing.value
  };
}

function readNodeSnapshot(node) {
  const raw = node.getPluginData(SNAPSHOT_PLUGIN_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== "string") {
      return null;
    }
    return {
      text: parsed.text,
      letterSpacing: serializeLetterSpacing(parsed.letterSpacing)
    };
  } catch (error) {
    console.warn("Не удалось прочитать snapshot слоя", error);
    return null;
  }
}

function writeNodeSnapshot(node, text, letterSpacing) {
  try {
    node.setPluginData(
      SNAPSHOT_PLUGIN_KEY,
      JSON.stringify({
        text,
        letterSpacing: serializeLetterSpacing(letterSpacing)
      })
    );
  } catch (error) {
    console.warn("Не удалось сохранить snapshot слоя", error);
  }
}

function clearNodeSnapshot(node) {
  try {
    node.setPluginData(SNAPSHOT_PLUGIN_KEY, "");
  } catch (error) {
    console.warn("Не удалось очистить snapshot слоя", error);
  }
}

function countInsertedBreaks(text) {
  const matches = text.match(/-\u200B/g);
  return matches ? matches.length : 0;
}

// After writing hyphenated text to a node, Figma performs its own line-break
// layout. Some inserted "-​" markers may end up mid-line because the simulation
// diverged from Figma's actual renderer (e.g. justified alignment, global
// line-break optimization). This function removes those spurious markers by
// cloning the node as a HEIGHT probe (fixed width, auto height) and checking
// whether removing each marker changes the rendered height. If height is
// unchanged, the marker wasn't causing a line break and is removed.
function removeSpuriousHyphens(node) {
  const text = node.characters;
  const markerLen = INSERTED_BREAK_MARKER.length;

  const positions = [];
  let searchFrom = 0;
  while (true) {
    const pos = text.indexOf(INSERTED_BREAK_MARKER, searchFrom);
    if (pos === -1) break;
    positions.push(pos);
    searchFrom = pos + 1;
  }

  if (positions.length === 0) return false;

  const probe = node.clone();
  probe.visible = false;
  probe.x = -100000;
  probe.y = -100000;
  probe.textAutoResize = "HEIGHT";

  try {
    probe.characters = text;
    const baselineHeight = probe.height;

    const toRemove = [];

    for (const pos of positions) {
      const testText = text.slice(0, pos) + text.slice(pos + markerLen);
      probe.characters = testText;
      if (Math.abs(probe.height - baselineHeight) < 0.5) {
        toRemove.push(pos);
      }
    }

    if (toRemove.length === 0) return false;

    let cleanText = text;
    for (let i = toRemove.length - 1; i >= 0; i--) {
      const p = toRemove[i];
      cleanText = cleanText.slice(0, p) + cleanText.slice(p + markerLen);
    }

    node.characters = cleanText;
    return true;
  } finally {
    probe.remove();
  }
}

// After removeSpuriousHyphens the layout may have shifted, leaving some
// prepositions at line ends that the simulation never saw. We probe each
// candidate by inserting a hard newline: if the height doesn't increase the
// break was already there → confirmed orphan → replace space with NBSP.
function fixOrphansAfterCleanup(node) {
  const text = node.characters;

  // Find spaces that follow a 1-3-letter Cyrillic orphan word and precede
  // the next word. Negative lookbehind ensures we don't match a suffix of a
  // longer word.
  const candidates = [];
  const re = /(?<![А-ЯЁа-яё])([А-ЯЁа-яё]{1,3}) (?=[А-ЯЁа-яё0-9«"(„])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!ORPHAN_WORDS.has(m[1].toLowerCase())) continue;
    candidates.push(m.index + m[1].length); // index of the space
  }

  if (candidates.length === 0) return false;

  const probe = node.clone();
  probe.visible = false;
  probe.x = -100000;
  probe.y = -100000;
  probe.textAutoResize = "HEIGHT";

  try {
    probe.characters = text;
    const baselineHeight = probe.height;

    const confirmed = [];
    for (const spacePos of candidates) {
      const testText = text.slice(0, spacePos) + "\n" + text.slice(spacePos + 1);
      probe.characters = testText;
      // Height same (within 0.5 px) → newline was redundant → natural break already there
      if (probe.height < baselineHeight + 0.5) {
        confirmed.push(spacePos);
      }
    }

    if (confirmed.length === 0) return false;

    let result = text;
    for (let i = confirmed.length - 1; i >= 0; i--) {
      const pos = confirmed[i];
      result = result.slice(0, pos) + NBSP + result.slice(pos + 1);
    }
    node.characters = result;
    return true;
  } finally {
    probe.remove();
  }
}

// After the greedy hyphenation pass, detect lines that are still sparse in
// Figma's ACTUAL rendering (not in the plugin's own simulation) and pull
// the first word of the next line onto the sparse line via hyphenation.
// This corrects discrepancies between the simulation and Figma's layout engine.
function addHyphensForSparseLines(node, settings) {
  // Disabled: ZWS-based second-pass cannot pull content from the next line.
  // Figma wraps at spaces before ZWS, so words placed on the next line stay
  // there even with a ZWS marker inside — the hyphen appears mid-line.
  return false;
  const text = node.characters;
  if (!text || text.length === 0) return false;
  const colW = node.width;
  if (colW <= 0) return false;

  const paraSpacingPx = typeof node.paragraphSpacing === "number"
    ? node.paragraphSpacing : 0;
  const globalTracking = getNodeLetterSpacing(node);

  const heightProbe = node.clone();
  heightProbe.visible = false;
  heightProbe.x = -100004;
  heightProbe.y = -100000;
  heightProbe.textAutoResize = "HEIGHT";

  const widthProbe = node.clone();
  widthProbe.visible = false;
  widthProbe.x = -100006;
  widthProbe.y = -100000;
  widthProbe.textAutoResize = "WIDTH_AND_HEIGHT";
  widthProbe.letterSpacing = globalTracking;

  const measureW = (t) => {
    widthProbe.characters = t;
    return widthProbe.width;
  };

  try {
    heightProbe.characters = text;
    const baseHeight = heightProbe.height;
    const wrapThreshold = baseHeight + paraSpacingPx + 0.5;

    // Detect all actual Figma line-break positions using height probe.
    // A wrap is confirmed when replacing that character with "\n" does NOT
    // increase height beyond the paragraph-spacing allowance — meaning Figma
    // was already breaking there.
    //
    // We check both regular spaces (type "soft") AND zero-width spaces inside
    // existing INSERTED_BREAK_MARKERs (type "zws").  Before this fix only
    // spaces were checked, so after the first hyphenation pass inserted many
    // ZWS breaks the lineStart pointer never advanced past them and subsequent
    // fillRatio calculations spanned multiple visual lines.

    const events = [];

    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") { events.push({ pos: i, type: "para" }); continue; }
      if (text[i] !== " ") continue;
      const testText = text.slice(0, i) + "\n" + text.slice(i + 1);
      heightProbe.characters = testText;
      if (heightProbe.height <= wrapThreshold) events.push({ pos: i, type: "soft" });
    }

    // Also probe every ZWS inside existing markers.
    let searchIdx = 0;
    while (true) {
      const mPos = text.indexOf(INSERTED_BREAK_MARKER, searchIdx);
      if (mPos === -1) break;
      const zwsCharPos = mPos + 1; // INSERTED_BREAK_MARKER = "-​"; ZWS is at index 1
      const testText = text.slice(0, zwsCharPos) + "\n" + text.slice(zwsCharPos + 1);
      heightProbe.characters = testText;
      if (heightProbe.height <= wrapThreshold) events.push({ pos: zwsCharPos, type: "zws" });
      searchIdx = mPos + 1;
    }

    events.sort((a, b) => a.pos - b.pos);

    const hasSoftWrap = events.some((e) => e.type === "soft");
    if (!hasSoftWrap) return false; // nothing to fix: all breaks are already at ZWS or para

    const fixes = [];
    let lineStart = 0;
    // After accepting a fix the immediately following soft-wrap line has
    // different content in the modified text — skip its sparse check to avoid
    // double-fixing based on stale positions.
    let skipNextSoftFill = false;

    for (const { pos, type } of events) {
      if (type === "para") { lineStart = pos + 1; skipNextSoftFill = false; continue; }

      const lineEnd = pos;
      const nextStart = pos + 1;

      if (type === "soft" && lineEnd > lineStart) {
        const lineContent = text.slice(lineStart, lineEnd);
        widthProbe.characters = lineContent;
        const fillRatio = widthProbe.width / colW;

        console.log("[SparseLineFix] line fill=", fillRatio.toFixed(2),
          "content=", lineContent.slice(0, 40));

        // fillRatio < 0.30 → paragraph-ending orphan line; hyphenation of the
        // next word cannot pull content back to fill it (ZWS verify always fails
        // because the next word fits the next line without overflow).
        const shouldFix = fillRatio < SPARSE_LINE_FILL_THRESHOLD &&
                          fillRatio >= 0.30 &&
                          !skipNextSoftFill;
        skipNextSoftFill = false;

        if (shouldFix) {
          // Locate first word of the next line.
          // Skip leading ZWS and NBSP (non-breaking space, U+00A0) — NBSP is
          // often used in Russian text between short prepositions and their
          // following word, which would otherwise merge them into one "word".
          let wordStart = nextStart;
          while (wordStart < text.length &&
                 (text[wordStart] === ZERO_WIDTH_SPACE ||
                  text[wordStart] === " ")) wordStart++;
          let wordEnd = wordStart;
          while (wordEnd < text.length &&
                 text[wordEnd] !== " " &&
                 text[wordEnd] !== " " &&
                 text[wordEnd] !== "\n" &&
                 text[wordEnd] !== ZERO_WIDTH_SPACE) {
            wordEnd++;
          }

          if (wordEnd > wordStart) {
            const nextWord = text.slice(wordStart, wordEnd);
            const breakOffsets = getAllBreakOffsetsInToken(nextWord, settings);
            console.log("[SparseLineFix] sparse! next word=", nextWord,
              "break offsets=", breakOffsets);

            for (const offsetInWord of breakOffsets) {
              // Two-condition width check:
              // 1. "lineContent W1-" fills the sparse line (>= threshold, <= colW)
              //    → the fragment fits without overflow.
              // 2. "lineContent W1-W2" OVERFLOWS the column (> colW)
              //    → Figma is forced to wrap at the ZWS between W1- and W2.
              //    Without condition 2, Figma ignores ZWS and keeps "W1-W2" on
              //    the same line (mid-line hyphen).
              const w1 = nextWord.slice(0, offsetInWord);
              const w2 = nextWord.slice(offsetInWord);
              widthProbe.characters = lineContent + " " + w1 + "-";
              const newFillRatio = widthProbe.width / colW;
              widthProbe.characters = lineContent + " " + w1 + "-" + w2;
              const fullFillRatio = widthProbe.width / colW;
              const accepted = newFillRatio >= SPARSE_LINE_FILL_THRESHOLD &&
                               newFillRatio <= 1.0 &&
                               fullFillRatio > 1.0;
              console.log("[SparseLineFix] offset=", offsetInWord,
                "w1fill=", newFillRatio.toFixed(2),
                "fullFill=", fullFillRatio.toFixed(2),
                accepted ? "ACCEPTED" : "rejected");
              if (accepted) {
                fixes.push({ insertPos: wordStart + offsetInWord });
                skipNextSoftFill = true;
                break;
              }
            }
          }
        }
      }

      // Always advance lineStart past confirmed wrap points (both space and ZWS).
      lineStart = nextStart;
    }

    if (fixes.length === 0) return false;

    let newText = text;
    for (const { insertPos } of [...fixes].sort((a, b) => b.insertPos - a.insertPos)) {
      newText = newText.slice(0, insertPos) + INSERTED_BREAK_MARKER + newText.slice(insertPos);
    }
    node.characters = newText;
    return true;
  } finally {
    heightProbe.remove();
    widthProbe.remove();
  }
}

// After global tracking is set, find lines that Figma still justifies with large
// gaps and expand their letter spacing individually via setRangeLetterSpacing.
// Only called when optimizeLetterSpacing is enabled and the node has uniform
// (non-mixed) typography so that range writes are safe.
function optimizeSparseLineTracking(node, settings) {
  const text = node.characters;
  if (!text || text.length === 0) return false;

  const colW = node.width;
  if (colW <= 0) return false;

  const fontSize = typeof node.fontSize === "number" && node.fontSize > 0
    ? node.fontSize : 16;
  const globalTracking = getNodeLetterSpacing(node);
  const globalPercent = convertNodeSpacingToPercent(globalTracking, node);
  const maxPercent = settings.letterSpacingMaxPercent;

  // Per-line expansion can go up to the user's maximum (hard cap).
  // No early exit based on globalPercent — even if global already sits at max,
  // there may be nothing to expand (sparseCandidates will be empty), but we let
  // the loop decide rather than bailing out here.
  const perLineMax = maxPercent;

  // --- height probe: find soft-wrap positions ---
  const heightProbe = node.clone();
  heightProbe.visible = false;
  heightProbe.x = -100000;
  heightProbe.y = -100000;
  heightProbe.textAutoResize = "HEIGHT";

  // --- width probe: measure natural line width at current tracking ---
  const widthProbe = node.clone();
  widthProbe.visible = false;
  widthProbe.x = -100002;
  widthProbe.y = -100000;
  widthProbe.textAutoResize = "WIDTH_AND_HEIGHT";
  widthProbe.letterSpacing = globalTracking;

  // When \n replaces a soft-wrap space, Figma converts the soft-wrap into a
  // paragraph break, adding paragraphSpacing to the total height even though
  // no new LINE was added.  We must account for this in the threshold.
  const paraSpacingPx = typeof node.paragraphSpacing === "number"
    ? node.paragraphSpacing : 0;

  try {
    heightProbe.characters = text;
    const baseHeight = heightProbe.height;

    // Collect positions of regular spaces (not NBSP) that are soft-wrap breaks.
    // Threshold: inserting \n at a soft-wrap adds at most paragraphSpacing to
    // height. Inserting at a non-wrap adds at least one lineHeight (>> paraSpacing).
    const softWrapThreshold = baseHeight + paraSpacingPx + 0.5;
    const softWrapPos = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== " ") continue;
      const testText = text.slice(0, i) + "\n" + text.slice(i + 1);
      heightProbe.characters = testText;
      if (heightProbe.height <= softWrapThreshold) {
        softWrapPos.push(i);
      }
    }

    if (softWrapPos.length === 0) return false;

    // Build a unified event list:
    //  "soft"   – regular-space soft-wrap (found by height probe above)
    //  "hyphen" – INSERTED_BREAK_MARKER already confirmed by removeSpuriousHyphens
    //  "para"   – explicit \n paragraph break
    //
    // Processing order: advance lineStart at every boundary; only attempt
    // tracking expansion on soft-wrap lines (not hyphenated or para-last lines).
    const events = softWrapPos.map((pos) => ({ pos, type: "soft" }));

    // All remaining INSERTED_BREAK_MARKERs are real line breaks.
    const markerLen = INSERTED_BREAK_MARKER.length;
    let searchIdx = 0;
    while (true) {
      const mPos = text.indexOf(INSERTED_BREAK_MARKER, searchIdx);
      if (mPos === -1) break;
      events.push({ pos: mPos, type: "hyphen" });
      searchIdx = mPos + 1;
    }

    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") events.push({ pos: i, type: "para" });
    }
    events.sort((a, b) => a.pos - b.pos);

    const TARGET_FILL = 0.90;
    const sparseCandidates = [];
    let lineStart = 0;

    for (const { pos, type } of events) {
      if (type === "para") {
        lineStart = pos + 1;
        continue;
      }

      // Line content and where the next line starts depend on break type.
      let lineEnd, nextStart;
      if (type === "soft") {
        lineEnd = pos;          // exclude the break space
        nextStart = pos + 1;
      } else {                  // "hyphen": marker = "-​" (2 chars)
        lineEnd = pos + markerLen;  // include the "-​" marker
        nextStart = pos + markerLen;
      }

      if (type === "soft" && lineEnd > lineStart) {
        const lineContent = text.slice(lineStart, lineEnd);
        widthProbe.characters = lineContent;
        const naturalWidth = widthProbe.width;
        const fillRatio = naturalWidth / colW;

        const wordCount = (lineContent.match(/\S+/g) || []).length;
        const extraGapFraction = wordCount > 1 ? (1 - fillRatio) / (wordCount - 1) : 0;
        const lineIsSparse = fillRatio < SPARSE_LINE_FILL_THRESHOLD ||
          extraGapFraction > SPARSE_GAP_FRACTION;

        if (lineIsSparse) {
          const nChars = [...lineContent].filter(
            (c) => c !== ZERO_WIDTH_SPACE
          ).length;
          if (nChars > 0) {
            const neededPx = (TARGET_FILL - fillRatio) * colW;
            const deltaPercent = (neededPx * 100) / (nChars * fontSize);
            const newPercent = Math.min(globalPercent + deltaPercent, perLineMax);
            // Skip if the achievable expansion is negligible or the line is so
            // sparse that even the maximum delta won't visibly help.
            if (newPercent - globalPercent >= 0.5) {
              sparseCandidates.push({ start: lineStart, end: nextStart, newPercent });
            }
          }
        }
      }

      lineStart = nextStart;
    }

    if (sparseCandidates.length === 0) return false;

    let changed = false;
    for (const { start, end, newPercent } of sparseCandidates) {
      node.setRangeLetterSpacing(start, end, {
        unit: globalTracking.unit,
        value: convertPercentSpacingToNodeUnit(newPercent, node, globalTracking.unit)
      });
      changed = true;
    }

    return changed;
  } finally {
    heightProbe.remove();
    widthProbe.remove();
  }
}

function fitsWithinWidth(text, maxWidth, measureWidth) {
  return measureWidth(text) <= maxWidth + WIDTH_EPSILON;
}

// When look-back re-queues a token sequence, orphan prepositions may end up
// at line-end because the anti-orphan guard in processOneParagraph fires with
// a different line context than the original pass.  Scan the array and join any
// [orphan_word, spaces, cyrillic_word] triplet with NBSP so the pair is treated
// as a single token on re-processing.
function preJoinOrphansInQueue(arr) {
  const out = [];
  let i = 0;
  while (i < arr.length) {
    const t = arr[i];
    if (!SPACE_TOKEN_REGEX.test(t)) {
      const cyr = t.replace(/[^А-ЯЁа-яё]/g, "").toLowerCase();
      if (ORPHAN_WORDS.has(cyr)) {
        let j = i + 1;
        while (j < arr.length && SPACE_TOKEN_REGEX.test(arr[j])) j++;
        if (j < arr.length && /^[А-ЯЁа-яё0-9«"(„]/.test(arr[j])) {
          out.push(t + NBSP + arr[j]);
          i = j + 1;
          continue;
        }
      }
    }
    out.push(t);
    i++;
  }
  return out;
}

// Returns all valid hyphenation offsets within token (chars from token start),
// ordered from longest-left to shortest-left. No width filtering — caller verifies.
function getAllBreakOffsetsInToken(token, options) {
  const minWordLength = (options != null && options.minWordLengthForHyphenation != null) ? options.minWordLengthForHyphenation : 4;
  const minBefore = (options != null && options.minLettersBeforeHyphen != null) ? options.minLettersBeforeHyphen : 2;
  const minAfter = (options != null && options.minLettersAfterHyphen != null) ? options.minLettersAfterHyphen : 3;
  const forbidden = (options != null && options.forbiddenBreaks instanceof Set) ? options.forbiddenBreaks : null;

  const match = token.match(RUSSIAN_TOKEN_REGEX);
  if (!match) return [];
  const leading = match[1];
  const core = match[2];
  if (core.length < minWordLength) return [];

  const parts = hypher.hyphenate(core);
  if (!parts || parts.length <= 1) return [];

  const offsets = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    const leftCore = parts.slice(0, i).join("");
    const rightCore = parts.slice(i).join("");
    if (leftCore.length < minBefore || rightCore.length < minAfter) continue;
    if (forbidden && forbidden.has(`${core}:${leftCore}`)) continue;
    offsets.push(leading.length + leftCore.length);
  }
  return offsets;
}

function findBestBreakInToken(token, remainingWidth, measureWidth, options) {
  const forbidden = options && options.forbiddenBreaks instanceof Set
    ? options.forbiddenBreaks : null;
  const minWordLength =
    options && typeof options.minWordLengthForHyphenation === "number"
      ? options.minWordLengthForHyphenation
      : 4;
  const minBefore =
    options && typeof options.minLettersBeforeHyphen === "number"
      ? options.minLettersBeforeHyphen
      : 2;
  const minAfter =
    options && typeof options.minLettersAfterHyphen === "number"
      ? options.minLettersAfterHyphen
      : 3;

  const match = token.match(RUSSIAN_TOKEN_REGEX);
  if (!match) {
    return null;
  }

  const leading = match[1];
  const core = match[2];
  const trailing = match[3];

  if (core.length < minWordLength) {
    return null;
  }

  const parts = hypher.hyphenate(core);
  if (!parts || parts.length <= 1) {
    return null;
  }

  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const leftCore = parts.slice(0, i).join("");
    const rightCore = parts.slice(i).join("");

    if (leftCore.length < minBefore || rightCore.length < minAfter) {
      continue;
    }

    if (forbidden && forbidden.has(`${core}:${leftCore}`)) {
      continue;
    }

    const leftWithDash = `${leading}${leftCore}-`;

    if (measureWidth(leftWithDash) <= remainingWidth + WIDTH_EPSILON) {
      return {
        left: `${leading}${leftCore}`,
        right: `${rightCore}${trailing}`
      };
    }
  }

  return null;
}

// Simulate line breaks for a single hyphenated paragraph (no \n inside).
// Mandatory breaks come from INSERTED_BREAK_MARKERs (token contains ​).
// Between those, words wrap greedily by measureWidth.
// Returns array of line strings ready for measureWidth calls.
function simulateParagraphLines(paraText, maxWidth, measureWidth) {
  const tokens = paraText.match(TOKEN_REGEX) || [];
  const lines = [];
  let currentLine = "";
  let pendingSpaces = "";

  for (const token of tokens) {
    if (SPACE_TOKEN_REGEX.test(token)) {
      pendingSpaces += token;
      continue;
    }

    if (token.includes(ZERO_WIDTH_SPACE)) {
      const cleanTok = token.replace(/​/g, "");
      currentLine += pendingSpaces + cleanTok;
      lines.push(currentLine);
      currentLine = "";
      pendingSpaces = "";
      continue;
    }

    const candidate = currentLine
      ? currentLine + pendingSpaces + token
      : token;
    if (!currentLine || fitsWithinWidth(candidate, maxWidth, measureWidth)) {
      currentLine = candidate;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = token;
    }
    pendingSpaces = "";
  }

  if (currentLine.trim()) lines.push(currentLine);
  return lines;
}

// Badness = sum of squared fill deficits for non-last lines with fill < threshold.
// The last line is excluded because Figma typically left-aligns it.
function computeParagraphBadness(lines, maxWidth, measureWidth) {
  if (lines.length <= 1) return 0;
  let badness = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const fill = maxWidth > 0 ? measureWidth(lines[i]) / maxWidth : 1;
    const deficit = Math.max(0, SPARSE_LINE_FILL_THRESHOLD - fill);
    badness += deficit * deficit;
  }
  return badness;
}

// Find hyphens in a first-pass result that have a short right part (≤ threshold).
// Short tails are the main cause of sparse next lines: "обеспече- | ние" leaves
// "ние" as a 3-char stub that contributes little to the next line's fill.
const SECOND_PASS_TAIL_MAX = 4;

function extractShortTailCandidates(resultText) {
  const tokens = resultText.match(TOKEN_REGEX) || [];
  const candidates = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.includes(ZERO_WIDTH_SPACE)) continue;

    // tok = "leadingChars leftCore -​"
    const leftFull = tok.replace(/-​$/, "");
    const leftMatch = leftFull.match(RUSSIAN_TOKEN_REGEX);
    if (!leftMatch) continue;
    const leftCore = leftMatch[2];

    // Peek at the next non-space token to get the right part
    let j = i + 1;
    while (j < tokens.length && SPACE_TOKEN_REGEX.test(tokens[j])) j++;
    if (j >= tokens.length) continue;

    const rightClean = tokens[j].replace(/-​[\s\S]*$/, "");
    const rightMatch = rightClean.match(RUSSIAN_TOKEN_REGEX);
    if (!rightMatch) continue;
    const rightCore = rightMatch[2];

    if (rightCore.length <= SECOND_PASS_TAIL_MAX) {
      candidates.push({ core: leftCore + rightCore, leftCore });
    }
  }

  return candidates;
}

// Core greedy hyphenation pass for a single paragraph (no \n).
// Returns { text, breakCount, unsolvedSparseLines }.
function processOneParagraph(lineText, maxWidth, measureWidth, options, maxHyphensPara, maxConsecHyphens) {
  const tokens = lineText.match(TOKEN_REGEX);
  if (!tokens) return { text: lineText, breakCount: 0, unsolvedSparseLines: 0 };

  let result = "";
  let currentLine = "";
  let pendingSpaces = "";
  let insertedBreaks = 0;
  let consecutiveHyphenLines = 0;
  let lineWordCount = 0;
  let lastWordInfo = null;
  let secondToLastWordInfo = null;
  let thirdToLastWordInfo = null;
  let fourthToLastWordInfo = null;
  let fifthToLastWordInfo = null;
  let prevLineLastWordInfo = null;
  let prevLineSecondToLastWordInfo = null;
  let prevLineWasNatural = false;
  let unsolvedSparseLines = 0;

  const processingQueue = Array.from(tokens);
  let qIdx = 0;

  while (qIdx < processingQueue.length) {
    const token = processingQueue[qIdx++];

    if (SPACE_TOKEN_REGEX.test(token)) {
      pendingSpaces += token;
      continue;
    }

    const resultLenBeforeSpaces = result.length;
    const currentLineBeforeSpaces = currentLine;
    const spacesForWord = pendingSpaces;

    result += pendingSpaces;
    let chunk = token;
    let linePrefix = `${currentLine}${pendingSpaces}`;

    while (chunk.length > 0) {
      if (fitsWithinWidth(`${linePrefix}${chunk}`, maxWidth, measureWidth)) {
        // Widow word fixup: when a short word is the first word on a new line after
        // a natural wrap, try hyphenating the second-to-last word of the previous
        // line so that its tail + the last word + this word land together.
        if (linePrefix === "" && prevLineWasNatural && prevLineSecondToLastWordInfo !== null) {
          const widowConsecLimitReached = maxConsecHyphens > 0 && consecutiveHyphenLines >= maxConsecHyphens;
          if (!widowConsecLimitReached) {
            const cyrillicChars = chunk.replace(/[^А-ЯЁа-яё]/g, "");
            if (cyrillicChars.length > 0 && cyrillicChars.length <= WIDOW_WORD_THRESHOLD) {
              const Y = prevLineSecondToLastWordInfo;
              const Z = prevLineLastWordInfo;
              if (Z !== null) {
                const remainingForY = maxWidth - measureWidth(Y.currentLineBefore + Y.spacesBeforeWord);
                if (remainingForY > 0) {
                  const yBreak = findBestBreakInToken(Y.token, remainingForY, measureWidth, options);
                  if (yBreak) {
                    const combinedWidth = measureWidth(
                      yBreak.right + Z.spacesBeforeWord + Z.token + spacesForWord + chunk
                    );
                    if (combinedWidth <= maxWidth + WIDTH_EPSILON) {
                      result = result.slice(0, Y.resultLenBeforeSpaces);
                      result += Y.spacesBeforeWord + yBreak.left + INSERTED_BREAK_MARKER;
                      insertedBreaks += 1;
                      consecutiveHyphenLines += 1;
                      const pushBack = preJoinOrphansInQueue([
                        yBreak.right,
                        ...(Z.spacesBeforeWord ? [Z.spacesBeforeWord] : []),
                        Z.token,
                        ...(spacesForWord ? [spacesForWord] : []),
                        chunk,
                      ]);
                      processingQueue.splice(qIdx, 0, ...pushBack);
                      prevLineLastWordInfo = null;
                      prevLineSecondToLastWordInfo = null;
                      prevLineWasNatural = false;
                      currentLine = "";
                      linePrefix = "";
                      lineWordCount = 0;
                      lastWordInfo = null;
                      secondToLastWordInfo = null;
                      thirdToLastWordInfo = null;
                      fourthToLastWordInfo = null;
                      fifthToLastWordInfo = null;
                      pendingSpaces = "";
                      chunk = "";
                      break;
                    }
                  }
                }
              }
            }
          }
        }
        if (linePrefix === "") {
          prevLineLastWordInfo = null;
          prevLineSecondToLastWordInfo = null;
          prevLineWasNatural = false;
        }
        result += chunk;
        currentLine = `${linePrefix}${chunk}`;
        chunk = "";
        lineWordCount++;
        fifthToLastWordInfo = fourthToLastWordInfo;
        fourthToLastWordInfo = thirdToLastWordInfo;
        thirdToLastWordInfo = secondToLastWordInfo;
        secondToLastWordInfo = lastWordInfo;
        const prevLastWordInfo = lastWordInfo;
        lastWordInfo = {
          token,
          resultLenBeforeSpaces,
          spacesBeforeWord: spacesForWord,
          currentLineBefore: currentLineBeforeSpaces
        };
        if (options && options.preventOrphans && currentLineBeforeSpaces.length > 0) {
          const lastPart = token.split(NBSP).pop();
          const cyrillicOnly = lastPart.replace(/[^А-ЯЁа-яё]/g, "").toLowerCase();
          if (ORPHAN_WORDS.has(cyrillicOnly)) {
            let pi = qIdx;
            while (pi < processingQueue.length && SPACE_TOKEN_REGEX.test(processingQueue[pi])) pi++;
            if (pi < processingQueue.length) {
              const nextTok = processingQueue[pi];
              const interSp = processingQueue.slice(qIdx, pi).join("");
              const nextStartsCyrillicOrDigit = /^[А-ЯЁа-яё0-9«"(„]/.test(nextTok);
              const fillAfterRollback = maxWidth > 0
                ? measureWidth(currentLineBeforeSpaces) / maxWidth
                : 0;
              // For single-letter prepositions (1–2 chars) always rollback.
              // For longer conjunctions like "или" (3+ chars), skip rollback if
              // doing so would create excessive justified gaps (fill < 0.93).
              const shouldSkipRollback = cyrillicOnly.length >= 3 && fillAfterRollback < 0.93;
              if (nextStartsCyrillicOrDigit && !fitsWithinWidth(currentLine + interSp + nextTok, maxWidth, measureWidth) && !shouldSkipRollback) {
                result = result.slice(0, resultLenBeforeSpaces);
                currentLine = currentLineBeforeSpaces;
                lineWordCount = Math.max(0, lineWordCount - 1);
                lastWordInfo = prevLastWordInfo;
                // The shift that happened when the rolled-back word was placed:
                // fifth→fourth→third→second→last. Reverse it one step.
                secondToLastWordInfo = thirdToLastWordInfo;
                thirdToLastWordInfo = fourthToLastWordInfo;
                fourthToLastWordInfo = fifthToLastWordInfo;
                fifthToLastWordInfo = null;
                processingQueue.splice(qIdx, pi - qIdx + 1);
                processingQueue.splice(qIdx, 0, token + NBSP + nextTok);
                if (spacesForWord.length > 0) {
                  processingQueue.splice(qIdx, 0, spacesForWord);
                }
              }
            }
          }
        }
        break;
      }

      const reachedParagraphLimit =
        maxHyphensPara > 0 && insertedBreaks >= maxHyphensPara;
      const reachedConsecutiveLimit =
        maxConsecHyphens > 0 && consecutiveHyphenLines >= maxConsecHyphens;
      const remainingWidth = Math.max(0, maxWidth - measureWidth(linePrefix));

      if (linePrefix.length > 0) {
        const lineFillRatio = maxWidth > 0 ? 1 - remainingWidth / maxWidth : 0;
        // Per-gap metric: extra justified space per inter-word gap as fraction of
        // line width. A line with 4 short words at 80% fill has (1-0.8)/3 = 6.7%
        // extra per gap — visually worse than 6 words at 70% fill (6% per gap).
        const extraGapFraction = lineWordCount > 1
          ? (1 - lineFillRatio) / (lineWordCount - 1)
          : 0;
        const isLineSparse = lineFillRatio > 0.1 && (
          lineFillRatio < SPARSE_LINE_FILL_THRESHOLD ||
          extraGapFraction > SPARSE_GAP_FRACTION
        );
        // Sparse lines override the consecutive-hyphen limit.
        const canBreak = (!reachedParagraphLimit || isLineSparse) &&
          (!reachedConsecutiveLimit || isLineSparse);

        let breakPoint = null;
        if (canBreak) {
          breakPoint = findBestBreakInToken(chunk, remainingWidth, measureWidth, options);
        }

        if (!breakPoint && isLineSparse) {
          breakPoint = findBestBreakInToken(chunk, remainingWidth, measureWidth, {
            ...options,
            minLettersBeforeHyphen: 1,
            minLettersAfterHyphen: 1
          });
        }

        if (breakPoint) {
          result += `${breakPoint.left}${INSERTED_BREAK_MARKER}`;
          insertedBreaks += 1;
          consecutiveHyphenLines += 1;
          chunk = breakPoint.right;
          currentLine = "";
          linePrefix = "";
          lineWordCount = 0;
          lastWordInfo = null;
          secondToLastWordInfo = null;
          thirdToLastWordInfo = null;
          fourthToLastWordInfo = null;
          fifthToLastWordInfo = null;
          prevLineLastWordInfo = null;
          prevLineSecondToLastWordInfo = null;
          prevLineWasNatural = false;
          continue;
        }

        // Look-back: line has 2–7 whole words and no syllable of the current token
        // fits in the remaining space. Cascade: last → second → third → fourth → fifth.
        const lbWordCount = lineWordCount === 2 ||
          (lineWordCount >= 3 && lineWordCount <= 7 && isLineSparse);
        if (lbWordCount && lastWordInfo !== null && (!reachedConsecutiveLimit || isLineSparse)) {
          const lw = lastWordInfo;
          const remainingForLw =
            maxWidth - measureWidth(lw.currentLineBefore + lw.spacesBeforeWord);
          const lbBreak = findBestBreakInToken(
            lw.token, remainingForLw, measureWidth, options
          );
          if (lbBreak) {
            result = result.slice(0, lw.resultLenBeforeSpaces);
            result += lw.spacesBeforeWord + lbBreak.left + INSERTED_BREAK_MARKER;
            insertedBreaks += 1;
            consecutiveHyphenLines += 1;
            {
              const raw = [lbBreak.right, ...(spacesForWord.length > 0 ? [spacesForWord] : []), token];
              processingQueue.splice(qIdx, 0, ...preJoinOrphansInQueue(raw));
            }
            currentLine = "";
            linePrefix = "";
            lineWordCount = 0;
            lastWordInfo = null;
            secondToLastWordInfo = null;
            thirdToLastWordInfo = null;
            fourthToLastWordInfo = null;
            fifthToLastWordInfo = null;
            prevLineLastWordInfo = null;
            prevLineSecondToLastWordInfo = null;
            prevLineWasNatural = false;
            chunk = "";
            break;
          }

          // Last word can't be broken — try second-to-last.
          if (lineWordCount >= 3 && lineWordCount <= 7 && isLineSparse &&
              secondToLastWordInfo !== null) {
            const slw = secondToLastWordInfo;
            const remainingForSlw =
              maxWidth - measureWidth(slw.currentLineBefore + slw.spacesBeforeWord);
            const slwBreak = findBestBreakInToken(
              slw.token, remainingForSlw, measureWidth, options
            );
            if (slwBreak) {
              result = result.slice(0, slw.resultLenBeforeSpaces);
              result += slw.spacesBeforeWord + slwBreak.left + INSERTED_BREAK_MARKER;
              insertedBreaks += 1;
              consecutiveHyphenLines += 1;
              const rawPushBack2 = [
                slwBreak.right,
                ...(lw.spacesBeforeWord ? [lw.spacesBeforeWord] : []),
                lw.token,
                ...(spacesForWord.length > 0 ? [spacesForWord] : []),
                token,
              ];
              processingQueue.splice(qIdx, 0, ...preJoinOrphansInQueue(rawPushBack2));
              currentLine = "";
              linePrefix = "";
              lineWordCount = 0;
              lastWordInfo = null;
              secondToLastWordInfo = null;
              thirdToLastWordInfo = null;
              fourthToLastWordInfo = null;
              fifthToLastWordInfo = null;
              prevLineLastWordInfo = null;
              prevLineSecondToLastWordInfo = null;
              prevLineWasNatural = false;
              chunk = "";
              break;
            }
          }

          // Second-to-last also can't be broken — try third-to-last.
          if (lineWordCount >= 3 && lineWordCount <= 7 && isLineSparse && thirdToLastWordInfo !== null) {
            const tlw = thirdToLastWordInfo;
            const slw = secondToLastWordInfo;
            const remainingForTlw =
              maxWidth - measureWidth(tlw.currentLineBefore + tlw.spacesBeforeWord);
            const tlwBreak = findBestBreakInToken(
              tlw.token, remainingForTlw, measureWidth, options
            );
            if (tlwBreak) {
              result = result.slice(0, tlw.resultLenBeforeSpaces);
              result += tlw.spacesBeforeWord + tlwBreak.left + INSERTED_BREAK_MARKER;
              insertedBreaks += 1;
              consecutiveHyphenLines += 1;
              const rawPushBack3 = [
                tlwBreak.right,
                ...(slw && slw.spacesBeforeWord ? [slw.spacesBeforeWord] : []),
                ...(slw ? [slw.token] : []),
                ...(lw.spacesBeforeWord ? [lw.spacesBeforeWord] : []),
                lw.token,
                ...(spacesForWord.length > 0 ? [spacesForWord] : []),
                token,
              ];
              processingQueue.splice(qIdx, 0, ...preJoinOrphansInQueue(rawPushBack3));
              currentLine = "";
              linePrefix = "";
              lineWordCount = 0;
              lastWordInfo = null;
              secondToLastWordInfo = null;
              thirdToLastWordInfo = null;
              fourthToLastWordInfo = null;
              fifthToLastWordInfo = null;
              prevLineLastWordInfo = null;
              prevLineSecondToLastWordInfo = null;
              prevLineWasNatural = false;
              chunk = "";
              break;
            }
          }

          // Third-to-last also can't be broken — try fourth-to-last.
          if (lineWordCount >= 4 && lineWordCount <= 7 && isLineSparse && fourthToLastWordInfo !== null) {
            const flw = fourthToLastWordInfo;
            const tlw = thirdToLastWordInfo;
            const slw = secondToLastWordInfo;
            const remainingForFlw =
              maxWidth - measureWidth(flw.currentLineBefore + flw.spacesBeforeWord);
            const flwBreak = findBestBreakInToken(
              flw.token, remainingForFlw, measureWidth, options
            );
            if (flwBreak) {
              result = result.slice(0, flw.resultLenBeforeSpaces);
              result += flw.spacesBeforeWord + flwBreak.left + INSERTED_BREAK_MARKER;
              insertedBreaks += 1;
              consecutiveHyphenLines += 1;
              const rawPushBack4 = [
                flwBreak.right,
                ...(tlw && tlw.spacesBeforeWord ? [tlw.spacesBeforeWord] : []),
                ...(tlw ? [tlw.token] : []),
                ...(slw && slw.spacesBeforeWord ? [slw.spacesBeforeWord] : []),
                ...(slw ? [slw.token] : []),
                ...(lw.spacesBeforeWord ? [lw.spacesBeforeWord] : []),
                lw.token,
                ...(spacesForWord.length > 0 ? [spacesForWord] : []),
                token,
              ];
              processingQueue.splice(qIdx, 0, ...preJoinOrphansInQueue(rawPushBack4));
              currentLine = "";
              linePrefix = "";
              lineWordCount = 0;
              lastWordInfo = null;
              secondToLastWordInfo = null;
              thirdToLastWordInfo = null;
              fourthToLastWordInfo = null;
              fifthToLastWordInfo = null;
              prevLineLastWordInfo = null;
              prevLineSecondToLastWordInfo = null;
              prevLineWasNatural = false;
              chunk = "";
              break;
            }
          }

          // Fourth-to-last also can't be broken — try fifth-to-last.
          if (lineWordCount >= 5 && lineWordCount <= 7 && isLineSparse && fifthToLastWordInfo !== null) {
            const xw = fifthToLastWordInfo;
            const flw = fourthToLastWordInfo;
            const tlw = thirdToLastWordInfo;
            const slw = secondToLastWordInfo;
            const remainingForXw =
              maxWidth - measureWidth(xw.currentLineBefore + xw.spacesBeforeWord);
            const xwBreak = findBestBreakInToken(
              xw.token, remainingForXw, measureWidth, options
            );
            if (xwBreak) {
              result = result.slice(0, xw.resultLenBeforeSpaces);
              result += xw.spacesBeforeWord + xwBreak.left + INSERTED_BREAK_MARKER;
              insertedBreaks += 1;
              consecutiveHyphenLines += 1;
              const rawPushBack5 = [
                xwBreak.right,
                ...(flw && flw.spacesBeforeWord ? [flw.spacesBeforeWord] : []),
                ...(flw ? [flw.token] : []),
                ...(tlw && tlw.spacesBeforeWord ? [tlw.spacesBeforeWord] : []),
                ...(tlw ? [tlw.token] : []),
                ...(slw && slw.spacesBeforeWord ? [slw.spacesBeforeWord] : []),
                ...(slw ? [slw.token] : []),
                ...(lw.spacesBeforeWord ? [lw.spacesBeforeWord] : []),
                lw.token,
                ...(spacesForWord.length > 0 ? [spacesForWord] : []),
                token,
              ];
              processingQueue.splice(qIdx, 0, ...preJoinOrphansInQueue(rawPushBack5));
              currentLine = "";
              linePrefix = "";
              lineWordCount = 0;
              lastWordInfo = null;
              secondToLastWordInfo = null;
              thirdToLastWordInfo = null;
              fourthToLastWordInfo = null;
              fifthToLastWordInfo = null;
              prevLineLastWordInfo = null;
              prevLineSecondToLastWordInfo = null;
              prevLineWasNatural = false;
              chunk = "";
              break;
            }
          }
        }

        // All break attempts (direct + look-back cascade) failed — truly unsolved.
        if (isLineSparse) {
          unsolvedSparseLines += 1;
        }
        prevLineLastWordInfo = lastWordInfo;
        prevLineSecondToLastWordInfo = secondToLastWordInfo;
        prevLineWasNatural = true;
        consecutiveHyphenLines = 0;
        linePrefix = "";
        lineWordCount = 0;
        lastWordInfo = null;
        secondToLastWordInfo = null;
        thirdToLastWordInfo = null;
        fourthToLastWordInfo = null;
        fifthToLastWordInfo = null;
        continue;
      }

      if (fitsWithinWidth(chunk, maxWidth, measureWidth)) {
        result += chunk;
        currentLine = chunk;
        chunk = "";
        lineWordCount++;
        secondToLastWordInfo = lastWordInfo;
        lastWordInfo = {
          token,
          resultLenBeforeSpaces,
          spacesBeforeWord: spacesForWord,
          currentLineBefore: currentLineBeforeSpaces
        };
        break;
      }

      const canBreakLong = !reachedParagraphLimit && !reachedConsecutiveLimit;
      const breakPoint = canBreakLong
        ? findBestBreakInToken(chunk, maxWidth, measureWidth, options)
        : null;
      if (breakPoint) {
        result += `${breakPoint.left}${INSERTED_BREAK_MARKER}`;
        insertedBreaks += 1;
        consecutiveHyphenLines += 1;
        chunk = breakPoint.right;
        currentLine = "";
        linePrefix = "";
        lineWordCount = 0;
        lastWordInfo = null;
        secondToLastWordInfo = null;
        thirdToLastWordInfo = null;
        fourthToLastWordInfo = null;
        fifthToLastWordInfo = null;
        prevLineLastWordInfo = null;
        prevLineSecondToLastWordInfo = null;
        prevLineWasNatural = false;
        continue;
      }

      consecutiveHyphenLines = 0;
      result += chunk;
      currentLine = chunk;
      chunk = "";
      lineWordCount++;
      fifthToLastWordInfo = fourthToLastWordInfo;
      fourthToLastWordInfo = thirdToLastWordInfo;
      thirdToLastWordInfo = secondToLastWordInfo;
      secondToLastWordInfo = lastWordInfo;
      lastWordInfo = {
        token,
        resultLenBeforeSpaces,
        spacesBeforeWord: spacesForWord,
        currentLineBefore: currentLineBeforeSpaces
      };
    }

    pendingSpaces = "";
  }

  result += pendingSpaces;

  // TeX-style post-pass: the last line of a paragraph never triggers an overflow,
  // so look-back never fires for it.  After the greedy loop, check whether the last
  // line is sparse and proactively break its last (or second-to-last) word.
  const postLoopConsecLimit = maxConsecHyphens > 0 && consecutiveHyphenLines >= maxConsecHyphens;
  if (lastWordInfo !== null && lineWordCount >= 2 && !postLoopConsecLimit) {
    const lastLineFill = maxWidth > 0 ? measureWidth(currentLine) / maxWidth : 1;
    const lastExtraGap = lineWordCount > 1
      ? (1 - lastLineFill) / (lineWordCount - 1)
      : 0;
    const lastLineSparse = lastLineFill > 0.1 && (
      lastLineFill < SPARSE_LINE_FILL_THRESHOLD || lastExtraGap > SPARSE_GAP_FRACTION
    );
    if (lastLineSparse) {
      const lw = lastWordInfo;
      const remainingForLw =
        maxWidth - measureWidth(lw.currentLineBefore + lw.spacesBeforeWord);
      const postBreak = findBestBreakInToken(lw.token, remainingForLw, measureWidth, options);
      if (postBreak) {
        result = result.slice(0, lw.resultLenBeforeSpaces);
        result += lw.spacesBeforeWord + postBreak.left + INSERTED_BREAK_MARKER + postBreak.right;
        insertedBreaks += 1;
      } else if (secondToLastWordInfo !== null) {
        const slw = secondToLastWordInfo;
        const remainingForSlw =
          maxWidth - measureWidth(slw.currentLineBefore + slw.spacesBeforeWord);
        const slwBreak = findBestBreakInToken(slw.token, remainingForSlw, measureWidth, options);
        if (slwBreak) {
          result = result.slice(0, slw.resultLenBeforeSpaces);
          result += slw.spacesBeforeWord + slwBreak.left + INSERTED_BREAK_MARKER;
          result += lw.spacesBeforeWord + lw.token;
          insertedBreaks += 1;
        }
      }
    }
  }

  // Count widow words: a short first word on a non-first, non-last simulated line
  const simLines = simulateParagraphLines(result, maxWidth, measureWidth);
  let widowWordLines = 0;
  for (let i = 1; i < simLines.length - 1; i++) {
    const lineTokens = simLines[i].match(TOKEN_REGEX) || [];
    const firstContent = lineTokens.find(t => !SPACE_TOKEN_REGEX.test(t));
    if (!firstContent) continue;
    const cyrillicLen = firstContent.replace(/[^А-ЯЁа-яё]/g, "").length;
    if (cyrillicLen > 0 && cyrillicLen <= WIDOW_WORD_THRESHOLD) {
      const contentCount = lineTokens.filter(t => !SPACE_TOKEN_REGEX.test(t)).length;
      if (contentCount >= 2) widowWordLines++;
    }
  }
  return { text: result, breakCount: insertedBreaks, unsolvedSparseLines, widowWordLines };
}

function hyphenateRussianTextWithVisibleDash(text, maxWidth, measureWidth, options) {
  const normalized = normalizeTextForRehyphenation(text);
  const paragraphs = normalized.split("\n");
  const maxHyphensPara =
    options && typeof options.maxHyphensPerParagraph === "number"
      ? options.maxHyphensPerParagraph
      : 0;
  const maxConsecHyphens =
    options && typeof options.maxConsecutiveHyphens === "number"
      ? options.maxConsecutiveHyphens
      : 0;

  let totalBreakCount = 0;
  let totalUnsolvedSparseLines = 0;
  let totalWidowWordLines = 0;
  const transformedParagraphs = [];

  for (const line of paragraphs) {
    if (!line.match(TOKEN_REGEX)) {
      transformedParagraphs.push(line);
      continue;
    }

    const paraResult = processOneParagraph(
      line, maxWidth, measureWidth, options, maxHyphensPara, maxConsecHyphens
    );

    totalBreakCount += paraResult.breakCount;
    totalUnsolvedSparseLines += paraResult.unsolvedSparseLines;
    totalWidowWordLines += paraResult.widowWordLines;
    transformedParagraphs.push(paraResult.text);
  }

  return {
    text: transformedParagraphs.join("\n"),
    breakCount: totalBreakCount,
    unsolvedSparseLines: totalUnsolvedSparseLines,
    widowWordLines: totalWidowWordLines
  };
}

function getNodeLetterSpacing(node) {
  const spacing = node.letterSpacing;
  if (!spacing || spacing === figma.mixed) {
    return {
      unit: "PIXELS",
      value: 0
    };
  }
  return spacing;
}

function sameLetterSpacing(a, b) {
  return a.unit === b.unit && Math.abs(a.value - b.value) < 0.0001;
}

function restoreFromSnapshot(node) {
  const snapshot = readNodeSnapshot(node);
  if (!snapshot) {
    return false;
  }

  // normalizeToCleanText strips any plugin markers that old buggy snapshots
  // may have stored (hyphens, NBSP). New snapshots are already clean.
  const cleanText = normalizeToCleanText(snapshot.text);

  let changed = false;
  if (node.characters !== cleanText) {
    node.characters = cleanText;
    changed = true;
  }

  if (
    snapshot.letterSpacing &&
    (node.letterSpacing === figma.mixed ||
      !sameLetterSpacing(snapshot.letterSpacing, getNodeLetterSpacing(node)))
  ) {
    node.letterSpacing = snapshot.letterSpacing;
    changed = true;
  }

  clearNodeSnapshot(node);
  return changed;
}

function convertPercentSpacingToNodeUnit(percentSpacing, node, unit) {
  if (unit === "PERCENT") {
    return percentSpacing;
  }
  const fontSize = typeof node.fontSize === "number" ? node.fontSize : 0;
  return (fontSize * percentSpacing) / 100;
}

function convertNodeSpacingToPercent(spacing, node) {
  if (!spacing) {
    return 0;
  }
  if (spacing.unit === "PERCENT") {
    return spacing.value;
  }
  const fontSize = typeof node.fontSize === "number" ? node.fontSize : 0;
  if (fontSize <= 0) {
    return 0;
  }
  return (spacing.value / fontSize) * 100;
}

function buildAlternatingPercentRange(minPercent, desiredPercent, maxPercent, stepPercent) {
  const result = [];
  const seen = new Set();

  function pushIfUnique(value) {
    const rounded = Number(value.toFixed(4));
    if (rounded < minPercent - 0.0001 || rounded > maxPercent + 0.0001) {
      return;
    }
    const key = rounded.toFixed(4);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(rounded);
  }

  pushIfUnique(desiredPercent);
  const maxDistance = Math.max(
    Math.abs(desiredPercent - minPercent),
    Math.abs(maxPercent - desiredPercent)
  );

  for (let distance = stepPercent; distance <= maxDistance + 0.0001; distance += stepPercent) {
    pushIfUnique(desiredPercent - distance);
    pushIfUnique(desiredPercent + distance);
  }

  return result;
}

function getLetterSpacingCandidates(node, settings) {
  const baseSpacing = getNodeLetterSpacing(node);
  const percentCandidates = buildAlternatingPercentRange(
    settings.letterSpacingMinPercent,
    settings.letterSpacingDesiredPercent,
    settings.letterSpacingMaxPercent,
    settings.letterSpacingStepPercent
  );
  const candidates = [];
  const seen = new Set();

  for (const percentValue of percentCandidates) {
    const value = convertPercentSpacingToNodeUnit(percentValue, node, baseSpacing.unit);
    const key = `${baseSpacing.unit}:${value.toFixed(4)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({
      letterSpacing: {
        unit: baseSpacing.unit,
        value
      },
      percentValue
    });
  }

  return candidates;
}

function hasMixedTypography(node) {
  // letterSpacing is intentionally excluded: we apply setRangeLetterSpacing
  // ourselves, which makes it figma.mixed on subsequent Apply calls.
  // Detecting font/size/lineHeight/case/decoration mixed is enough to decide
  // whether uniform tracking optimization is safe.
  const props = [
    node.fontName,
    node.fontSize,
    node.lineHeight,
    node.textCase,
    node.textDecoration
  ];

  return props.some((value) => value === figma.mixed);
}

function createCloneWidthMeasurer(node, letterSpacing) {
  const probe = node.clone();
  probe.visible = false;
  probe.x = -100000;
  probe.y = -100000;
  probe.textAutoResize = "WIDTH_AND_HEIGHT";

  let cache = new Map();

  function applyLetterSpacing(spacing) {
    if (!spacing) return;
    try {
      probe.letterSpacing = spacing;
    } catch (error) {
      // Для смешанной типографики не всегда можно выставить единый letter spacing.
    }
  }

  applyLetterSpacing(letterSpacing);

  const measure = (text) => {
    if (!text || text.length === 0) {
      return 0;
    }

    const cached = cache.get(text);
    if (cached !== undefined) {
      return cached;
    }

    probe.characters = text;
    const width = probe.width;
    cache.set(text, width);
    return width;
  };

  return {
    measure,
    setLetterSpacing(spacing) {
      applyLetterSpacing(spacing);
      cache = new Map();
    },
    destroy() {
      probe.remove();
    }
  };
}

function createWidthMeasurer(node, letterSpacing) {
  // В published-окружении запись в figma.createText() может падать,
  // если системный Inter ещё не загружен. Клон текущего узла снимает это ограничение.
  return createCloneWidthMeasurer(node, letterSpacing);
}

function collectTextNodes(nodes) {
  const textNodes = [];
  const seen = new Set();

  for (const node of nodes) {
    if (node.type === "TEXT") {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        textNodes.push(node);
      }
      continue;
    }

    if ("findAll" in node) {
      const nestedTextNodes = node.findAll((child) => child.type === "TEXT");
      for (const textNode of nestedTextNodes) {
        if (!seen.has(textNode.id)) {
          seen.add(textNode.id);
          textNodes.push(textNode);
        }
      }
    }
  }

  return textNodes;
}

async function loadFontsForNode(node) {
  if (!node.characters || node.characters.length === 0) {
    return;
  }

  const fonts = node.getRangeAllFontNames(0, node.characters.length);
  const uniqueFonts = new Map();

  for (const font of fonts) {
    uniqueFonts.set(`${font.family}__${font.style}`, font);
  }

  for (const font of uniqueFonts.values()) {
    await figma.loadFontAsync(font);
  }
}

async function setWatchNodes(textNodes) {
  watchedNodeIds = new Set(textNodes.map((node) => node.id));
  await refreshWatchedNodeWidths();
}

function clearWatchNodes() {
  watchedNodeIds.clear();
  watchedNodeWidths.clear();
  autoRecalcQueued = false;
  if (autoRecalcTimer) {
    clearTimeout(autoRecalcTimer);
    autoRecalcTimer = null;
  }
}

async function refreshWatchedNodeWidths() {
  const nextIds = new Set();
  const nextWidths = new Map();

  for (const id of watchedNodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type !== "TEXT") {
      continue;
    }
    nextIds.add(id);
    nextWidths.set(id, node.width);
  }

  watchedNodeIds = nextIds;
  watchedNodeWidths = nextWidths;
}

async function getWatchedTextNodes() {
  const nodes = [];
  for (const id of watchedNodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && node.type === "TEXT") {
      nodes.push(node);
    }
  }
  return nodes;
}

async function didWatchedWidthChange() {
  let changed = false;
  const nextIds = new Set();
  const nextWidths = new Map();

  for (const id of watchedNodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type !== "TEXT") {
      continue;
    }

    nextIds.add(id);
    nextWidths.set(id, node.width);

    const previousWidth = watchedNodeWidths.get(id);
    if (
      previousWidth === undefined ||
      Math.abs(previousWidth - node.width) > WIDTH_EPSILON
    ) {
      changed = true;
    }
  }

  watchedNodeIds = nextIds;
  watchedNodeWidths = nextWidths;

  return changed;
}

function suppressOwnDocumentChanges() {
  const nextSuppressUntil = Date.now() + SELF_CHANGE_SUPPRESS_MS;
  suppressDocumentChangeUntil = Math.max(
    suppressDocumentChangeUntil,
    nextSuppressUntil
  );
}

function buildApplyMessage(changedNodes, skippedNodes, skippedMixedTypography) {
  if (changedNodes === 0) {
    if (skippedNodes > 0) {
      let skippedMessage = `Пропущено слоёв: ${skippedNodes}.`;
      if (skippedMixedTypography > 0) {
        skippedMessage += ` Смешанная типографика: ${skippedMixedTypography}.`;
      }
      return {
        kind: "error",
        text: `Не удалось применить переносы. ${skippedMessage}`
      };
    }

    return {
      kind: "info",
      text: "Переносы уже применены или русских слов не найдено."
    };
  }

  let skippedMessage = "";
  if (skippedNodes > 0) {
    skippedMessage = `, пропущено: ${skippedNodes}`;
    if (skippedMixedTypography > 0) {
      skippedMessage += ` (смешанная типографика: ${skippedMixedTypography})`;
    }
  }

  return {
    kind: "success",
    text: `Готово: обработано ${changedNodes} слоёв${skippedMessage}.`
  };
}

function buildResetMessage(changedNodes, skippedNodes) {
  if (changedNodes === 0) {
    if (skippedNodes > 0) {
      return {
        kind: "error",
        text: `Не удалось выполнить сброс. Пропущено слоёв: ${skippedNodes}.`
      };
    }

    return {
      kind: "info",
      text: "Сбрасывать нечего: переносы не найдены."
    };
  }

  const skippedMessage = skippedNodes > 0 ? `, пропущено: ${skippedNodes}` : "";
  return {
    kind: "success",
    text: `Готово: сброшены переносы в ${changedNodes} слоёв${skippedMessage}.`
  };
}

async function processSelection(mode) {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    return {
      kind: "error",
      text: "Выделите текстовый слой или группу с текстом.",
      debug: null
    };
  }

  const textNodes = collectTextNodes(selection);
  if (textNodes.length === 0) {
    return {
      kind: "error",
      text: "В выделении нет текстовых слоёв.",
      debug: null
    };
  }

  return processTextNodes(textNodes, mode, runtimeSettings);
}

async function processTextNodes(textNodes, mode, settings) {
  const isResetMode = mode === RESET_MODE;

  let changedNodes = 0;
  let skippedNodes = 0;
  let skippedMixedTypography = 0;
  const skippedReasons = [];

  function pushSkippedReason(node, reason) {
    if (skippedReasons.length >= 80) {
      return;
    }
    skippedReasons.push({
      nodeId: node.id,
      nodeName: node.name,
      reason
    });
  }

  for (const node of textNodes) {
    try {
      await loadFontsForNode(node);

      const original = node.characters;

      // Existing snapshot (from a previous Apply) holds the true pre-plugin
      // text and letter spacing. We preserve both across repeated Apply calls
      // so that Reset always returns to the user's original state.
      const existingSnapshot = readNodeSnapshot(node);

      const originalLetterSpacing = existingSnapshot && existingSnapshot.letterSpacing
        ? existingSnapshot.letterSpacing
        : getNodeLetterSpacing(node);

      // Always snapshot the normalised text so old plugin markers are stripped.
      const cleanOriginal = normalizeToCleanText(original);

      let transformed = original;
      let hasNodeChanges = false;
      let mixedTypography = false;
      let nodeSettings = settings;

      if (isResetMode) {
        if (restoreFromSnapshot(node)) {
          changedNodes += 1;
          continue;
        }
        transformed = resetHyphenationText(original);
      } else {
        mixedTypography = hasMixedTypography(node);
        // Per-node settings: auto-tighten hyphenation and letter-spacing range
        // for narrow columns based on block width and font size.
        nodeSettings = deriveSettingsForNode(node, settings);

        let preparedText = settings.autoNbsp
          ? applyNonBreakingSpaces(cleanOriginal)
          : cleanOriginal;

        if (settings.optimizeLetterSpacing && !mixedTypography) {
          const currentSpacing = getNodeLetterSpacing(node);
          const currentSpacingPercent = convertNodeSpacingToPercent(originalLetterSpacing, node);
          const candidates = getLetterSpacingCandidates(node, nodeSettings);

          let bestText = preparedText;
          let bestSpacing = originalLetterSpacing;
          let bestBreakCount = Number.POSITIVE_INFINITY;
          let bestEffectiveSparse = Number.POSITIVE_INFINITY;
          let bestDesiredPenalty = Number.POSITIVE_INFINITY;
          let bestCurrentPenalty = Number.POSITIVE_INFINITY;

          const measurer = createWidthMeasurer(node);
          try {
            for (const candidate of candidates) {
              measurer.setLetterSpacing(candidate.letterSpacing);
              const hyphenResult = hyphenateRussianTextWithVisibleDash(
                preparedText,
                node.width,
                measurer.measure,
                nodeSettings
              );
              const breakCount = hyphenResult.breakCount;
              const sparseCount = hyphenResult.unsolvedSparseLines;
              const widowCount = hyphenResult.widowWordLines;
              const desiredPenalty = Math.abs(
                candidate.percentValue - nodeSettings.letterSpacingDesiredPercent
              );
              const currentPenalty = Math.abs(
                candidate.percentValue - currentSpacingPercent
              );

              // Compression below the desired value carries a fractional cost so
              // the optimizer doesn't aggressively over-compress to eliminate a
              // marginal sparse line.  Each 1 % below desired counts as 0.3 of an
              // additional sparse line (i.e. 4 % compression ≈ 1.2 extra sparse).
              // Each widow word (short first word on a line) also counts as 0.5
              // sparse lines, so the optimizer avoids creating widows when choosing tracking.
              const compressionPenalty = Math.max(
                0,
                nodeSettings.letterSpacingDesiredPercent - candidate.percentValue
              ) * 0.3;
              const effectiveSparse = sparseCount + compressionPenalty + widowCount * 0.5;

              const isBetter =
                effectiveSparse < bestEffectiveSparse - 0.0001 ||
                (Math.abs(effectiveSparse - bestEffectiveSparse) < 0.0001 && breakCount < bestBreakCount) ||
                (Math.abs(effectiveSparse - bestEffectiveSparse) < 0.0001 && breakCount === bestBreakCount &&
                  desiredPenalty < bestDesiredPenalty) ||
                (Math.abs(effectiveSparse - bestEffectiveSparse) < 0.0001 && breakCount === bestBreakCount &&
                  Math.abs(desiredPenalty - bestDesiredPenalty) < 0.0001 &&
                  currentPenalty < bestCurrentPenalty);

              if (isBetter) {
                bestEffectiveSparse = effectiveSparse;
                bestBreakCount = breakCount;
                bestDesiredPenalty = desiredPenalty;
                bestCurrentPenalty = currentPenalty;
                bestText = hyphenResult.text;
                bestSpacing = candidate.letterSpacing;
              }
            }
          } finally {
            measurer.destroy();
          }

          transformed = bestText;
          if (!sameLetterSpacing(bestSpacing, currentSpacing)) {
            node.letterSpacing = bestSpacing;
            hasNodeChanges = true;
          }
        } else {
          if (settings.optimizeLetterSpacing && mixedTypography) {
            skippedMixedTypography += 1;
          }
          const measurer = createWidthMeasurer(node);
          try {
            transformed = hyphenateRussianTextWithVisibleDash(
              preparedText,
              node.width,
              measurer.measure,
              nodeSettings
            ).text;
          } finally {
            measurer.destroy();
          }
        }
      }

      if (transformed !== original) {
        node.characters = transformed;
        removeSpuriousHyphens(node);
        if (settings.preventOrphans) {
          // Two passes: first fixes "и" at line-end, second catches "с" that
          // slides to line-end after "и" gets joined to the next word.
          fixOrphansAfterCleanup(node);
          fixOrphansAfterCleanup(node);
        }
        hasNodeChanges = true;
      }

      if (!isResetMode && !mixedTypography) {
        if (addHyphensForSparseLines(node, nodeSettings)) {
          hasNodeChanges = true;
        }
      }

      if (!isResetMode && settings.optimizeLetterSpacing && !mixedTypography) {
        if (optimizeSparseLineTracking(node, nodeSettings)) {
          // Tracking changes shift line breaks — re-verify hyphens and orphans.
          removeSpuriousHyphens(node);
          if (settings.preventOrphans) {
            fixOrphansAfterCleanup(node);
            fixOrphansAfterCleanup(node);
          }
          hasNodeChanges = true;
        }
      }

      if (hasNodeChanges) {
        if (isResetMode) {
          clearNodeSnapshot(node);
        } else {
          writeNodeSnapshot(node, cleanOriginal, originalLetterSpacing);
        }
        changedNodes += 1;
      }
    } catch (error) {
      skippedNodes += 1;
      pushSkippedReason(
        node,
        error instanceof Error ? error.message : "Неизвестная ошибка"
      );
      console.error(`Не удалось обработать слой ${node.name}`, error);
    }
  }

  const debug = {
    mode,
    totalNodes: textNodes.length,
    changedNodes,
    skippedNodes,
    skippedMixedTypography,
    skippedReasons
  };

  if (isResetMode) {
    return {
      ...buildResetMessage(changedNodes, skippedNodes),
      debug
    };
  }

  return {
    ...buildApplyMessage(changedNodes, skippedNodes, skippedMixedTypography),
    debug
  };
}

function postUiStatus(message, kind) {
  figma.ui.postMessage({
    type: "status",
    kind,
    message
  });
}

function postUiSettings() {
  figma.ui.postMessage({
    type: "settings",
    settings: runtimeSettings
  });
}

function postUiDebug(debug) {
  figma.ui.postMessage({
    type: "debug",
    debug
  });
}

function setUiLoading(isLoading) {
  figma.ui.postMessage({
    type: "loading",
    isLoading
  });
}

function enableAutoWatchFromSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    clearWatchNodes();
    return Promise.resolve(0);
  }

  const textNodes = collectTextNodes(selection);
  return setWatchNodes(textNodes).then(() => textNodes.length);
}

function scheduleAutoRecalc() {
  if (autoRecalcTimer) {
    clearTimeout(autoRecalcTimer);
  }

  autoRecalcTimer = setTimeout(() => {
    autoRecalcTimer = null;
    void runAutoRecalc();
  }, AUTO_RECALC_DEBOUNCE_MS);
}

async function runAutoRecalc() {
  if (watchedNodeIds.size === 0) {
    return;
  }

  if (autoRecalcInProgress) {
    autoRecalcQueued = true;
    return;
  }

  const watchedNodes = await getWatchedTextNodes();
  if (watchedNodes.length === 0) {
    clearWatchNodes();
    postUiStatus("Автопересчёт остановлен: отслеживаемые слои не найдены.", "info");
    return;
  }

  autoRecalcInProgress = true;
  setUiLoading(true);
  suppressOwnDocumentChanges();

  try {
    const result = await processTextNodes(watchedNodes, APPLY_MODE, runtimeSettings);
    await refreshWatchedNodeWidths();
    postUiDebug(result.debug);

    if (result.kind === "error") {
      postUiStatus(`Автопересчёт: ${result.text}`, "error");
    } else {
      postUiStatus("Автопересчёт выполнен после изменения ширины.", "info");
    }
  } catch (error) {
    console.error("Ошибка автопересчёта при изменении ширины", error);
    postUiStatus("Не удалось выполнить автопересчёт при изменении ширины.", "error");
    postUiDebug(null);
  } finally {
    autoRecalcInProgress = false;
    suppressOwnDocumentChanges();
    setUiLoading(false);

    if (autoRecalcQueued) {
      autoRecalcQueued = false;
      scheduleAutoRecalc();
    }
  }
}

async function handleAction(mode) {
  manualActionInProgress = true;
  setUiLoading(true);
  suppressOwnDocumentChanges();
  try {
    const result = await processSelection(mode);
    postUiDebug(result.debug);

    if (mode === APPLY_MODE) {
      if (result.kind === "error") {
        clearWatchNodes();
        postUiStatus(result.text, result.kind);
      } else {
        if (runtimeSettings.autoWatch) {
          const watchedCount = await enableAutoWatchFromSelection();
          if (watchedCount > 0) {
            postUiStatus(
              `${result.text} Автопересчёт включён: при изменении ширины переносы обновляются автоматически.`,
              result.kind
            );
          } else {
            clearWatchNodes();
            postUiStatus(result.text, result.kind);
          }
        } else {
          clearWatchNodes();
          postUiStatus(
            `${result.text} Автопересчёт выключен в настройках.`,
            result.kind
          );
        }
      }
    } else if (mode === RESET_MODE) {
      clearWatchNodes();
      postUiStatus(`${result.text} Авторежим отключён.`, result.kind);
    } else {
      postUiStatus(result.text, result.kind);
    }

    await refreshWatchedNodeWidths();
    figma.notify(result.text);
  } catch (error) {
    console.error("Ошибка выполнения команды плагина", error);
    const fallback = "Не удалось выполнить команду плагина.";
    figma.notify(fallback);
    postUiStatus(fallback, "error");
    postUiDebug(null);
  } finally {
    manualActionInProgress = false;
    // Продлеваем окно подавления: Figma может сгенерировать documentchange
    // с задержкой после завершения async-записи в документ.
    suppressOwnDocumentChanges();
    setUiLoading(false);

    if (autoRecalcQueued && watchedNodeIds.size > 0) {
      autoRecalcQueued = false;
      scheduleAutoRecalc();
    }
  }
}

async function run() {
  try {
    figma.showUI(__html__, {
      width: UI_WINDOW_WIDTH,
      height: UI_INITIAL_HEIGHT,
      themeColors: false
    });
  } catch (error) {
    console.error("Не удалось открыть UI плагина", error);
    figma.notify("Не удалось открыть UI плагина.");
    return;
  }

  await loadRuntimeSettings();
  postUiSettings();
  postUiDebug(null);
  postUiStatus("Выделите текст и выберите действие.", "info");

  figma.ui.onmessage = async (message) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "resize-ui") {
      try {
        const w = (typeof message.width === "number" && message.width > 0)
          ? Math.round(Math.max(200, Math.min(800, message.width)))
          : UI_WINDOW_WIDTH;
        figma.ui.resize(w, normalizeUiHeight(message.height));
      } catch (error) {
        console.warn("Не удалось изменить размер UI плагина", error);
      }
      return;
    }

    if (message.type === "request-settings") {
      postUiSettings();
      return;
    }

    if (message.type === "save-settings") {
      runtimeSettings = normalizeSettings({
        ...runtimeSettings,
        ...message.settings
      });
      await persistRuntimeSettings();
      postUiSettings();
      return;
    }

    if (message.type === "open-external") {
      if (typeof message.url === "string" && message.url.length > 0) {
        figma.openExternal(message.url);
      }
      return;
    }

    if (message.type === APPLY_MODE || message.type === RESET_MODE) {
      await handleAction(message.type);
    }
  };

  try {
    // В published/incremental режиме подписка на documentchange требует загрузки всех страниц.
    await figma.loadAllPagesAsync();
    figma.on("documentchange", async () => {
      if (!runtimeSettings.autoWatch) {
        return;
      }

      if (watchedNodeIds.size === 0) {
        return;
      }

      if (Date.now() < suppressDocumentChangeUntil) {
        return;
      }

      if (manualActionInProgress || autoRecalcInProgress) {
        if (await didWatchedWidthChange()) {
          autoRecalcQueued = true;
        }
        return;
      }

      if (!(await didWatchedWidthChange())) {
        return;
      }

      scheduleAutoRecalc();
    });
  } catch (error) {
    // Если documentchange недоступен в среде публикации, оставляем ручной режим.
    console.warn("Автопересчёт отключён: documentchange недоступен.", error);
    runtimeSettings = normalizeSettings({
      ...runtimeSettings,
      autoWatch: false
    });
    await persistRuntimeSettings();
    postUiSettings();
    postUiStatus(
      "Автопересчёт отключён в этой среде. Ручной режим доступен.",
      "info"
    );
  }
}

void run().catch((error) => {
  console.error("Критическая ошибка запуска плагина", error);
  figma.notify("Ошибка запуска плагина.");
});
