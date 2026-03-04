const Hypher = require("hypher");
const russianPatterns = require("hyphenation.ru");

const ZERO_WIDTH_SPACE = "\u200B";
const INSERTED_BREAK_MARKER = `-${ZERO_WIDTH_SPACE}`;
const hypher = new Hypher(russianPatterns);
const TOKEN_REGEX = /(\n|[^\S\n]+|[^\s]+)/g;
const SPACE_TOKEN_REGEX = /^[^\S\n]+$/;
const RUSSIAN_TOKEN_REGEX = /^([^А-ЯЁа-яё-]*)([А-ЯЁа-яё]+)([^А-ЯЁа-яё-]*)$/;
const WIDTH_EPSILON = 0.01;
const APPLY_MODE = "apply";
const RESET_MODE = "reset";

function normalizeTextForRehyphenation(text) {
  return text.replace(/\u00AD/g, "").replace(/-\u200B/g, "");
}

function resetHyphenationText(text) {
  return normalizeTextForRehyphenation(text);
}

function fitsWithinWidth(text, maxWidth, measureWidth) {
  return measureWidth(text) <= maxWidth + WIDTH_EPSILON;
}

function findBestBreakInToken(token, remainingWidth, measureWidth) {
  const match = token.match(RUSSIAN_TOKEN_REGEX);
  if (!match) {
    return null;
  }

  const leading = match[1];
  const core = match[2];
  const trailing = match[3];

  if (core.length < 4 || core.includes("-")) {
    return null;
  }

  const parts = hypher.hyphenate(core);
  if (!parts || parts.length <= 1) {
    return null;
  }

  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const leftCore = parts.slice(0, i).join("");
    const rightCore = parts.slice(i).join("");
    const leftWithDash = `${leading}${leftCore}-`;

    if (fitsWithinWidth(leftWithDash, remainingWidth, measureWidth)) {
      return {
        left: `${leading}${leftCore}`,
        right: `${rightCore}${trailing}`
      };
    }
  }

  return null;
}

function hyphenateRussianTextWithVisibleDash(text, maxWidth, measureWidth) {
  const normalized = normalizeTextForRehyphenation(text);
  const tokens = normalized.match(TOKEN_REGEX);

  if (!tokens) {
    return normalized;
  }

  let result = "";
  let currentLine = "";
  let pendingSpaces = "";

  for (const token of tokens) {
    if (token === "\n") {
      result += `${pendingSpaces}\n`;
      currentLine = "";
      pendingSpaces = "";
      continue;
    }

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

      const remainingWidth = Math.max(0, maxWidth - measureWidth(linePrefix));
      if (linePrefix.length > 0) {
        const breakPoint = findBestBreakInToken(
          chunk,
          remainingWidth,
          measureWidth
        );

        if (breakPoint) {
          result += `${breakPoint.left}${INSERTED_BREAK_MARKER}`;
          chunk = breakPoint.right;
          currentLine = "";
          linePrefix = "";
          continue;
        }

        // Если в текущей строке нет подходящей точки, переносим токен на новую строку.
        linePrefix = "";
        continue;
      }

      if (fitsWithinWidth(chunk, maxWidth, measureWidth)) {
        result += chunk;
        currentLine = chunk;
        chunk = "";
        break;
      }

      const breakPoint = findBestBreakInToken(chunk, maxWidth, measureWidth);
      if (breakPoint) {
        result += `${breakPoint.left}${INSERTED_BREAK_MARKER}`;
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

function createWidthMeasurer(node) {
  const probe = figma.createText();
  probe.visible = false;
  probe.x = -100000;
  probe.y = -100000;
  probe.textAutoResize = "WIDTH_AND_HEIGHT";
  probe.fontName = node.fontName;
  probe.fontSize = node.fontSize;
  probe.lineHeight = node.lineHeight;
  probe.letterSpacing = node.letterSpacing;
  probe.textCase = node.textCase;
  probe.textDecoration = node.textDecoration;

  const cache = new Map();
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
    destroy() {
      probe.remove();
    }
  };
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
  const isResetMode = mode === RESET_MODE;
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    return {
      kind: "error",
      text: "Выделите текстовый слой или группу с текстом."
    };
  }

  const textNodes = collectTextNodes(selection);
  if (textNodes.length === 0) {
    return {
      kind: "error",
      text: "В выделении нет текстовых слоёв."
    };
  }

  let changedNodes = 0;
  let skippedNodes = 0;
  let skippedMixedTypography = 0;

  for (const node of textNodes) {
    try {
      await loadFontsForNode(node);

      const original = node.characters;
      let transformed = original;

      if (isResetMode) {
        transformed = resetHyphenationText(original);
      } else {
        if (hasMixedTypography(node)) {
          skippedNodes += 1;
          skippedMixedTypography += 1;
          continue;
        }

        const measurer = createWidthMeasurer(node);
        try {
          transformed = hyphenateRussianTextWithVisibleDash(
            original,
            node.width,
            measurer.measure
          );
        } finally {
          measurer.destroy();
        }
      }

      if (transformed !== original) {
        node.characters = transformed;
        changedNodes += 1;
      }
    } catch (error) {
      skippedNodes += 1;
      console.error(`Не удалось обработать слой ${node.name}`, error);
    }
  }

  if (isResetMode) {
    return buildResetMessage(changedNodes, skippedNodes);
  }

  return buildApplyMessage(changedNodes, skippedNodes, skippedMixedTypography);
}

function postUiStatus(message, kind) {
  figma.ui.postMessage({
    type: "status",
    kind,
    message
  });
}

function setUiLoading(isLoading) {
  figma.ui.postMessage({
    type: "loading",
    isLoading
  });
}

async function handleAction(mode) {
  setUiLoading(true);
  try {
    const result = await processSelection(mode);
    figma.notify(result.text);
    postUiStatus(result.text, result.kind);
  } catch (error) {
    console.error("Ошибка выполнения команды плагина", error);
    const fallback = "Не удалось выполнить команду плагина.";
    figma.notify(fallback);
    postUiStatus(fallback, "error");
  } finally {
    setUiLoading(false);
  }
}

function run() {
  figma.showUI(__html__, {
    width: 300,
    height: 408,
    themeColors: false
  });

  postUiStatus("Выделите текст и выберите действие.", "info");

  figma.ui.onmessage = async (message) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "close") {
      figma.closePlugin();
      return;
    }

    if (message.type === APPLY_MODE || message.type === RESET_MODE) {
      await handleAction(message.type);
    }
  };
}

run();
