const Hypher = require("hypher");
const russianPatterns = require("hyphenation.ru");

const ZERO_WIDTH_SPACE = "\u200B";
const INSERTED_BREAK_MARKER = `-${ZERO_WIDTH_SPACE}`;
const hypher = new Hypher(russianPatterns);
const TOKEN_REGEX = /(\n|[^\S\n]+|[^\s]+)/g;
const SPACE_TOKEN_REGEX = /^[^\S\n]+$/;
const RUSSIAN_TOKEN_REGEX = /^([^А-ЯЁа-яё-]*)([А-ЯЁа-яё]+)([^А-ЯЁа-яё-]*)$/;
const WIDTH_EPSILON = 0.01;
const SPARSE_LINE_FILL_THRESHOLD = 0.75;
const NBSP = "\u00A0";
const AUTO_RECALC_DEBOUNCE_MS = 280;
const SELF_CHANGE_SUPPRESS_MS = 600;
const SETTINGS_STORAGE_KEY = "hyphenationSettingsV6";
const SNAPSHOT_PLUGIN_KEY = "hyphenationSnapshotV4";
const APPLY_MODE = "apply";
const RESET_MODE = "reset";
const UI_WINDOW_WIDTH = 300;
const UI_INITIAL_HEIGHT = 220;
const UI_MIN_HEIGHT = 160;
const UI_MAX_HEIGHT = 720;


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
  hangingHyphen: true,
  optimizeLetterSpacing: true,
  minWordLengthForHyphenation: 5,
  minLettersBeforeHyphen: 2,
  minLettersAfterHyphen: 3,
  maxConsecutiveHyphens: 2,
  letterSpacingMinPercent: -3,
  letterSpacingDesiredPercent: 0,
  letterSpacingMaxPercent: 2,
  letterSpacingStepPercent: 0.5
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
  const hangingHyphen =
    typeof src.hangingHyphen === "boolean" ? src.hangingHyphen : DEFAULT_SETTINGS.hangingHyphen;
  const optimizeLetterSpacing =
    typeof src.optimizeLetterSpacing === "boolean"
      ? src.optimizeLetterSpacing
      : DEFAULT_SETTINGS.optimizeLetterSpacing;

  const minWordLengthForHyphenation = clampNumber(
    Number(src.minWordLengthForHyphenation ?? DEFAULT_SETTINGS.minWordLengthForHyphenation),
    4, 12
  );

  const minLettersBeforeHyphen = clampNumber(
    Number(src.minLettersBeforeHyphen ?? DEFAULT_SETTINGS.minLettersBeforeHyphen),
    1, 5
  );

  const minLettersAfterHyphen = clampNumber(
    Number(src.minLettersAfterHyphen ?? DEFAULT_SETTINGS.minLettersAfterHyphen),
    1, 5
  );

  const maxConsecutiveHyphens = clampNumber(
    Number(src.maxConsecutiveHyphens ?? DEFAULT_SETTINGS.maxConsecutiveHyphens),
    0, 5
  );

  const minPercent = clampNumber(
    Number(src.letterSpacingMinPercent ?? DEFAULT_SETTINGS.letterSpacingMinPercent), -10, 10
  );
  const desiredPercent = clampNumber(
    Number(src.letterSpacingDesiredPercent ?? DEFAULT_SETTINGS.letterSpacingDesiredPercent), -10, 10
  );
  const maxPercent = clampNumber(
    Number(src.letterSpacingMaxPercent ?? DEFAULT_SETTINGS.letterSpacingMaxPercent), -10, 10
  );
  const stepPercent = clampNumber(
    Number(src.letterSpacingStepPercent ?? DEFAULT_SETTINGS.letterSpacingStepPercent), 0.1, 5
  );

  const sortedMin = Math.min(minPercent, maxPercent);
  const sortedMax = Math.max(minPercent, maxPercent);
  const sortedDesired = clampNumber(desiredPercent, sortedMin, sortedMax);

  return {
    autoWatch,
    preventOrphans,
    hangingHyphen,
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
  const paragraphs = normalized.split("\n");
  const maxHyphensPerParagraph =
    options && typeof options.maxHyphensPerParagraph === "number"
      ? options.maxHyphensPerParagraph
      : 0;

  const maxConsecutiveHyphens =
    options && typeof options.maxConsecutiveHyphens === "number"
      ? options.maxConsecutiveHyphens
      : 0;

  let totalBreakCount = 0;
  let totalUnsolvedSparseLines = 0;
  const transformedParagraphs = [];

  for (const line of paragraphs) {
    const tokens = line.match(TOKEN_REGEX);

    if (!tokens) {
      transformedParagraphs.push(line);
      continue;
    }

    let result = "";
    let currentLine = "";
    let pendingSpaces = "";
    let insertedBreaks = 0;
    let consecutiveHyphenLines = 0;

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
        const reachedConsecutiveLimit =
          maxConsecutiveHyphens > 0 && consecutiveHyphenLines >= maxConsecutiveHyphens;
        const remainingWidth = Math.max(0, maxWidth - measureWidth(linePrefix));

        if (linePrefix.length > 0) {
          const lineFillRatio = maxWidth > 0 ? 1 - remainingWidth / maxWidth : 0;
          const isLineSparse =
            lineFillRatio > 0.1 && lineFillRatio < SPARSE_LINE_FILL_THRESHOLD;

          const canBreak = (!reachedParagraphLimit || isLineSparse) && !reachedConsecutiveLimit;

          let breakPoint = null;
          if (canBreak) {
            breakPoint = findBestBreakInToken(chunk, remainingWidth, measureWidth, options);
          }

          // Sparse-line fallback: relax Before/After limits to 1 letter each.
          // This finds hyphenation points that stricter settings would skip.
          if (!breakPoint && isLineSparse && !reachedConsecutiveLimit) {
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
            continue;
          }

          if (isLineSparse) {
            totalUnsolvedSparseLines += 1;
          }

          consecutiveHyphenLines = 0;
          linePrefix = "";
          continue;
        }

        if (fitsWithinWidth(chunk, maxWidth, measureWidth)) {
          result += chunk;
          currentLine = chunk;
          chunk = "";
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
          continue;
        }

        consecutiveHyphenLines = 0;
        result += chunk;
        currentLine = chunk;
        chunk = "";
      }

      pendingSpaces = "";
    }

    result += pendingSpaces;
    totalBreakCount += insertedBreaks;
    transformedParagraphs.push(result);
  }

  return {
    text: transformedParagraphs.join("\n"),
    breakCount: totalBreakCount,
    unsolvedSparseLines: totalUnsolvedSparseLines
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

      // Existing snapshot (from a previous Apply) holds the true pre-plugin
      // text and letter spacing. We preserve both across repeated Apply calls
      // so that Reset always returns to the user's original state.
      const existingSnapshot = readNodeSnapshot(node);

      const originalLetterSpacing = existingSnapshot && existingSnapshot.letterSpacing
        ? existingSnapshot.letterSpacing
        : getNodeLetterSpacing(node);

      // Always snapshot the normalised text so old plugin markers are stripped.
      const cleanOriginal = normalizeTextForRehyphenation(original);

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

        let preparedText = settings.preventOrphans
          ? preventRussianOrphans(cleanOriginal)
          : cleanOriginal;

        if (settings.optimizeLetterSpacing && !mixedTypography) {
          const currentSpacing = getNodeLetterSpacing(node);
          const currentSpacingPercent = convertNodeSpacingToPercent(originalLetterSpacing, node);
          const candidates = getLetterSpacingCandidates(node, settings);

          let bestText = preparedText;
          let bestSpacing = originalLetterSpacing;
          let bestBreakCount = Number.POSITIVE_INFINITY;
          let bestSparseCount = Number.POSITIVE_INFINITY;
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
                settings
              );
              const breakCount = hyphenResult.breakCount;
              const sparseCount = hyphenResult.unsolvedSparseLines;
              const desiredPenalty = Math.abs(
                candidate.percentValue - settings.letterSpacingDesiredPercent
              );
              const currentPenalty = Math.abs(
                candidate.percentValue - currentSpacingPercent
              );

              const isBetter =
                sparseCount < bestSparseCount ||
                (sparseCount === bestSparseCount && breakCount < bestBreakCount) ||
                (sparseCount === bestSparseCount && breakCount === bestBreakCount &&
                  desiredPenalty < bestDesiredPenalty) ||
                (sparseCount === bestSparseCount && breakCount === bestBreakCount &&
                  Math.abs(desiredPenalty - bestDesiredPenalty) < 0.0001 &&
                  currentPenalty < bestCurrentPenalty);

              if (isBetter) {
                bestSparseCount = sparseCount;
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
              settings
            ).text;
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
        figma.ui.resize(UI_WINDOW_WIDTH, normalizeUiHeight(message.height));
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
