const Hypher = require("hypher");
const russianPatterns = require("hyphenation.ru");

const ZERO_WIDTH_SPACE = "\u200B";
const INSERTED_BREAK_MARKER = `-${ZERO_WIDTH_SPACE}`;
const hypher = new Hypher(russianPatterns);
const TOKEN_REGEX = /(\n|[^\S\n]+|[^\s]+)/g;
const SPACE_TOKEN_REGEX = /^[^\S\n]+$/;
const RUSSIAN_TOKEN_REGEX = /^([^А-ЯЁа-яё-]*)([А-ЯЁа-яё]+)([^А-ЯЁа-яё-]*)$/;
const HYPHENATION_INTENSITY_ORDER = {
  soft: 0,
  normal: 1,
  aggressive: 2
};
const WIDTH_EPSILON = 0.01;
const SPARSE_LINE_FILL_THRESHOLD = 0.75;
const NBSP = "\u00A0";
const AUTO_RECALC_DEBOUNCE_MS = 280;
const SELF_CHANGE_SUPPRESS_MS = 600;
const SETTINGS_STORAGE_KEY = "hyphenationSettingsV4";
const SNAPSHOT_PLUGIN_KEY = "hyphenationSnapshotV4";
const APPLY_MODE = "apply";
const RESET_MODE = "reset";
const CUSTOM_PRESET = "custom";
const UI_WINDOW_WIDTH = 270;
const UI_INITIAL_HEIGHT = 760;
const UI_MIN_HEIGHT = 620;
const UI_MAX_HEIGHT = 1100;

const TYPOGRAPHY_PRESETS = {
  interface: {
    autoWatch: true,
    preventOrphans: true,
    hangingHyphen: true,
    optimizeLetterSpacing: true,
    minWordLengthForHyphenation: 4,
    hyphenationIntensity: "normal",
    maxHyphensPerParagraph: 0,
    letterSpacingMinPercent: -3,
    letterSpacingDesiredPercent: 0,
    letterSpacingMaxPercent: 3,
    letterSpacingStepPercent: 0.5
  },
  book: {
    autoWatch: true,
    preventOrphans: true,
    hangingHyphen: false,
    optimizeLetterSpacing: true,
    minWordLengthForHyphenation: 5,
    hyphenationIntensity: "soft",
    maxHyphensPerParagraph: 2,
    letterSpacingMinPercent: -1,
    letterSpacingDesiredPercent: 0,
    letterSpacingMaxPercent: 1,
    letterSpacingStepPercent: 0.5
  },
  dense: {
    autoWatch: true,
    preventOrphans: true,
    hangingHyphen: true,
    optimizeLetterSpacing: true,
    minWordLengthForHyphenation: 4,
    hyphenationIntensity: "aggressive",
    maxHyphensPerParagraph: 0,
    letterSpacingMinPercent: -4,
    letterSpacingDesiredPercent: -1,
    letterSpacingMaxPercent: 2,
    letterSpacingStepPercent: 0.5
  }
};

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
  preset: "interface",
  ...TYPOGRAPHY_PRESETS.interface
};

let watchedNodeIds = new Set();
let watchedNodeWidths = new Map();
let autoRecalcTimer = null;
let autoRecalcInProgress = false;
let autoRecalcQueued = false;
let suppressDocumentChangeUntil = 0;
let manualActionInProgress = false;
let runtimeSettings = { ...DEFAULT_SETTINGS };
let documentChangeWatchSupported = true;

function clampNumber(value, minValue, maxValue) {
  if (Number.isNaN(value)) {
    return minValue;
  }
  return Math.max(minValue, Math.min(maxValue, value));
}

function normalizePresetName(value) {
  if (typeof value !== "string") {
    return CUSTOM_PRESET;
  }
  if (value in TYPOGRAPHY_PRESETS || value === CUSTOM_PRESET) {
    return value;
  }
  return CUSTOM_PRESET;
}

function normalizeUiHeight(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return UI_INITIAL_HEIGHT;
  }
  return Math.round(clampNumber(parsed, UI_MIN_HEIGHT, UI_MAX_HEIGHT));
}

function normalizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const preset = normalizePresetName(source.preset || DEFAULT_SETTINGS.preset);

  const fallbackProfile =
    preset in TYPOGRAPHY_PRESETS
      ? TYPOGRAPHY_PRESETS[preset]
      : TYPOGRAPHY_PRESETS[DEFAULT_SETTINGS.preset];

  const autoWatch =
    typeof source.autoWatch === "boolean"
      ? source.autoWatch
      : fallbackProfile.autoWatch;
  const preventOrphans =
    typeof source.preventOrphans === "boolean"
      ? source.preventOrphans
      : fallbackProfile.preventOrphans;
  const hangingHyphen =
    typeof source.hangingHyphen === "boolean"
      ? source.hangingHyphen
      : fallbackProfile.hangingHyphen;
  const optimizeLetterSpacing =
    typeof source.optimizeLetterSpacing === "boolean"
      ? source.optimizeLetterSpacing
      : fallbackProfile.optimizeLetterSpacing;
  const minWordLengthForHyphenation = clampNumber(
    Number(
      source.minWordLengthForHyphenation ??
        fallbackProfile.minWordLengthForHyphenation
    ),
    4,
    12
  );
  const hyphenationIntensityRaw = String(
    source.hyphenationIntensity ?? fallbackProfile.hyphenationIntensity
  );
  const hyphenationIntensity =
    hyphenationIntensityRaw === "soft" ||
    hyphenationIntensityRaw === "normal" ||
    hyphenationIntensityRaw === "aggressive"
      ? hyphenationIntensityRaw
      : fallbackProfile.hyphenationIntensity;
  const maxHyphensPerParagraph = clampNumber(
    Number(
      source.maxHyphensPerParagraph ?? fallbackProfile.maxHyphensPerParagraph
    ),
    0,
    20
  );

  const minPercent = clampNumber(
    Number(source.letterSpacingMinPercent ?? fallbackProfile.letterSpacingMinPercent),
    -10,
    10
  );
  const desiredPercent = clampNumber(
    Number(
      source.letterSpacingDesiredPercent ??
        fallbackProfile.letterSpacingDesiredPercent
    ),
    -10,
    10
  );
  const maxPercent = clampNumber(
    Number(source.letterSpacingMaxPercent ?? fallbackProfile.letterSpacingMaxPercent),
    -10,
    10
  );

  const stepPercent = clampNumber(
    Number(source.letterSpacingStepPercent ?? fallbackProfile.letterSpacingStepPercent),
    0.1,
    5
  );

  const sortedMin = Math.min(minPercent, maxPercent);
  const sortedMax = Math.max(minPercent, maxPercent);
  const sortedDesired = clampNumber(desiredPercent, sortedMin, sortedMax);

  return {
    preset,
    autoWatch,
    preventOrphans,
    hangingHyphen,
    optimizeLetterSpacing,
    minWordLengthForHyphenation,
    hyphenationIntensity,
    maxHyphensPerParagraph,
    letterSpacingMinPercent: sortedMin,
    letterSpacingDesiredPercent: sortedDesired,
    letterSpacingMaxPercent: sortedMax,
    letterSpacingStepPercent: stepPercent
  };
}

function getPresetSettings(presetName) {
  const name = normalizePresetName(presetName);
  if (!(name in TYPOGRAPHY_PRESETS)) {
    return null;
  }
  return normalizeSettings({
    preset: name,
    ...TYPOGRAPHY_PRESETS[name]
  });
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
  return text.replace(/\u00AD/g, "").replace(/-\u200B/g, "").replace(/\u200B/g, "");
}

function resetHyphenationText(text) {
  return normalizeTextForRehyphenation(text).replace(
    /(^|[\s(«„“"'])([А-Яа-яЁё]{1,3})\u00A0(?=[А-Яа-яЁё0-9])/g,
    (match, prefix, word) => {
      if (!ORPHAN_WORDS.has(word.toLowerCase())) {
        return match;
      }
      return `${prefix}${word} `;
    }
  );
}

function preventRussianOrphans(text) {
  return text.replace(
    /(^|[\s(«„“"'])([А-Яа-яЁё]{1,3})[^\S\n]+(?=[А-Яа-яЁё0-9])/g,
    (match, prefix, word) => {
      if (!ORPHAN_WORDS.has(word.toLowerCase())) {
        return match;
      }
      return `${prefix}${word}${NBSP}`;
    }
  );
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

function fitsWithinWidth(text, maxWidth, measureWidth) {
  return measureWidth(text) <= maxWidth + WIDTH_EPSILON;
}

function findBestBreakInToken(token, remainingWidth, measureWidth, options) {
  const useHangingHyphen = Boolean(options && options.hangingHyphen);
  const minWordLength =
    options && typeof options.minWordLengthForHyphenation === "number"
      ? options.minWordLengthForHyphenation
      : 4;
  const intensity =
    options && typeof options.hyphenationIntensity === "string"
      ? options.hyphenationIntensity
      : "normal";
  const minIntensityRank =
    intensity in HYPHENATION_INTENSITY_ORDER
      ? HYPHENATION_INTENSITY_ORDER[intensity]
      : HYPHENATION_INTENSITY_ORDER.normal;
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
    const shortFragment = Math.min(leftCore.length, rightCore.length);
    const fragmentIntensityRank =
      shortFragment >= 3
        ? HYPHENATION_INTENSITY_ORDER.soft
        : shortFragment === 2
          ? HYPHENATION_INTENSITY_ORDER.normal
          : HYPHENATION_INTENSITY_ORDER.aggressive;

    if (fragmentIntensityRank < minIntensityRank) {
      continue;
    }

    const leftWithDash = `${leading}${leftCore}-`;
    const leftWithoutDash = `${leading}${leftCore}`;
    const widthWithoutDash = measureWidth(leftWithoutDash);
    const widthWithDash = measureWidth(leftWithDash);
    const dashWidth = Math.max(0, widthWithDash - widthWithoutDash);

    const fitsNormally = widthWithDash <= remainingWidth + WIDTH_EPSILON;
    const fitsWithHangingHyphen =
      useHangingHyphen &&
      widthWithoutDash <= remainingWidth + WIDTH_EPSILON &&
      widthWithDash <= remainingWidth + dashWidth + 0.5;

    if (fitsNormally || fitsWithHangingHyphen) {
      return {
        left: `${leading}${leftCore}`,
        right: `${rightCore}${trailing}`
      };
    }
  }

  return null;
}

function hyphenateRussianTextWithVisibleDash(text, maxWidth, measureWidth, options) {
  const normalized = normalizeTextForRehyphenation(text);
  const lines = normalized.split("\n");
  const maxHyphensPerParagraph =
    options && typeof options.maxHyphensPerParagraph === "number"
      ? options.maxHyphensPerParagraph
      : 0;

  const transformedLines = lines.map((line) => {
    const tokens = line.match(TOKEN_REGEX);

    if (!tokens) {
      return line;
    }

    let result = "";
    let currentLine = "";
    let pendingSpaces = "";
    let insertedBreaks = 0;

    for (const token of tokens) {
      if (SPACE_TOKEN_REGEX.test(token)) {
        pendingSpaces += token;
        continue;
      }

      result += pendingSpaces;
      let chunk = token;
      let linePrefix = `${currentLine}${pendingSpaces}`;

      while (chunk.length > 0) {
        if (fitsWithinWidth(`${linePrefix}${chunk}`, maxWidth, measureWidth)) {
          result += chunk;
          currentLine = `${linePrefix}${chunk}`;
          chunk = "";
          break;
        }

        const reachedParagraphLimit =
          maxHyphensPerParagraph > 0 && insertedBreaks >= maxHyphensPerParagraph;
        const remainingWidth = Math.max(0, maxWidth - measureWidth(linePrefix));

        if (linePrefix.length > 0) {
          // Use already-computed remainingWidth to avoid extra measureWidth call.
          const lineFillRatio = maxWidth > 0 ? 1 - remainingWidth / maxWidth : 0;
          const isLineSparse =
            lineFillRatio > 0.1 && lineFillRatio < SPARSE_LINE_FILL_THRESHOLD;

          // Sparse lines override the paragraph hyphen limit to reduce large gaps.
          let breakPoint = null;
          if (!reachedParagraphLimit || isLineSparse) {
            breakPoint = findBestBreakInToken(
              chunk,
              remainingWidth,
              measureWidth,
              options
            );
          }

          // Fallback to "soft" intensity: it allows long-fragment breaks (shortFragment >= 3)
          // that "normal" and "aggressive" modes skip. For sparse lines this finds better
          // break positions than aggressive (which requires 1-char fragments).
          if (!breakPoint && isLineSparse) {
            breakPoint = findBestBreakInToken(chunk, remainingWidth, measureWidth, {
              ...options,
              hyphenationIntensity: "soft"
            });
          }

          if (breakPoint) {
            result += `${breakPoint.left}${INSERTED_BREAK_MARKER}`;
            insertedBreaks += 1;
            chunk = breakPoint.right;
            currentLine = "";
            linePrefix = "";
            continue;
          }

          linePrefix = "";
          continue;
        }

        if (fitsWithinWidth(chunk, maxWidth, measureWidth)) {
          result += chunk;
          currentLine = chunk;
          chunk = "";
          break;
        }

        const breakPoint = reachedParagraphLimit
          ? null
          : findBestBreakInToken(
              chunk,
              maxWidth,
              measureWidth,
              options
            );
        if (breakPoint) {
          result += `${breakPoint.left}${INSERTED_BREAK_MARKER}`;
          insertedBreaks += 1;
          chunk = breakPoint.right;
          currentLine = "";
          linePrefix = "";
          continue;
        }

        result += chunk;
        currentLine = chunk;
        chunk = "";
      }

      pendingSpaces = "";
    }

    result += pendingSpaces;
    return result;
  });

  return transformedLines.join("\n");
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

  let changed = false;
  if (node.characters !== snapshot.text) {
    node.characters = snapshot.text;
    changed = true;
  }

  if (
    snapshot.letterSpacing &&
    !sameLetterSpacing(snapshot.letterSpacing, getNodeLetterSpacing(node))
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
  const props = [
    node.fontName,
    node.fontSize,
    node.lineHeight,
    node.letterSpacing,
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
      const originalLetterSpacing = getNodeLetterSpacing(node);
      let transformed = original;
      let hasNodeChanges = false;

      if (isResetMode) {
        if (restoreFromSnapshot(node)) {
          changedNodes += 1;
          continue;
        }
        transformed = resetHyphenationText(original);
      } else {
        const mixedTypography = hasMixedTypography(node);

        let normalized = normalizeTextForRehyphenation(original);

        let preparedText = settings.preventOrphans
          ? preventRussianOrphans(normalized)
          : normalized;

        if (settings.optimizeLetterSpacing && !mixedTypography) {
          const currentSpacing = getNodeLetterSpacing(node);
          const currentSpacingPercent = convertNodeSpacingToPercent(currentSpacing, node);
          const candidates = getLetterSpacingCandidates(node, settings);

          let bestText = preparedText;
          let bestSpacing = currentSpacing;
          let bestBreakCount = Number.POSITIVE_INFINITY;
          let bestDesiredPenalty = Number.POSITIVE_INFINITY;
          let bestCurrentPenalty = Number.POSITIVE_INFINITY;

          const measurer = createWidthMeasurer(node);
          try {
            for (const candidate of candidates) {
              measurer.setLetterSpacing(candidate.letterSpacing);
              const candidateText = hyphenateRussianTextWithVisibleDash(
                preparedText,
                node.width,
                measurer.measure,
                settings
              );
              const breakCount = countInsertedBreaks(candidateText);
              const desiredPenalty = Math.abs(
                candidate.percentValue - settings.letterSpacingDesiredPercent
              );
              const currentPenalty = Math.abs(
                candidate.percentValue - currentSpacingPercent
              );

              if (
                breakCount < bestBreakCount ||
                (breakCount === bestBreakCount && desiredPenalty < bestDesiredPenalty) ||
                (breakCount === bestBreakCount &&
                  Math.abs(desiredPenalty - bestDesiredPenalty) < 0.0001 &&
                  currentPenalty < bestCurrentPenalty)
              ) {
                bestBreakCount = breakCount;
                bestDesiredPenalty = desiredPenalty;
                bestCurrentPenalty = currentPenalty;
                bestText = candidateText;
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
              settings
            );
          } finally {
            measurer.destroy();
          }
        }
      }

      if (transformed !== original) {
        node.characters = transformed;
        hasNodeChanges = true;
      }

      if (hasNodeChanges) {
        if (isResetMode) {
          clearNodeSnapshot(node);
        } else {
          writeNodeSnapshot(node, original, originalLetterSpacing);
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
    settings: runtimeSettings,
    presets: Object.keys(TYPOGRAPHY_PRESETS)
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
        const w = (message.width && message.width > 0) ? message.width : UI_WINDOW_WIDTH;
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

    if (message.type === "select-preset") {
      const preset = getPresetSettings(message.preset);
      if (!preset) {
        postUiStatus("Неизвестный пресет типографики.", "error");
        return;
      }
      runtimeSettings = preset;
      await persistRuntimeSettings();
      postUiSettings();
      postUiStatus(`Применён пресет: ${message.preset}.`, "info");
      return;
    }

    if (message.type === "save-settings") {
      runtimeSettings = normalizeSettings({
        ...runtimeSettings,
        ...message.settings,
        preset: CUSTOM_PRESET
      });
      await persistRuntimeSettings();
      postUiSettings();
      return;
    }

    if (message.type === "open-external") {
      if (message.url) {
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
