const Hypher = require("hypher");
const russianPatterns = require("hyphenation.ru");

const SOFT_HYPHEN = "\u00AD";
const hypher = new Hypher(russianPatterns);
const RUSSIAN_WORD_REGEX = /[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*/g;

function hyphenateRussianSegment(segment) {
  if (segment.length < 4) {
    return segment;
  }

  const parts = hypher.hyphenate(segment);
  if (!parts || parts.length <= 1) {
    return segment;
  }

  return parts.join(SOFT_HYPHEN);
}

function hyphenateRussianWord(word) {
  return word
    .split("-")
    .map((part) => hyphenateRussianSegment(part))
    .join("-");
}

function hyphenateRussianText(text) {
  const normalized = text.replace(/\u00AD/g, "");
  return normalized.replace(RUSSIAN_WORD_REGEX, (word) =>
    hyphenateRussianWord(word)
  );
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

async function run() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.notify("Выделите текстовый слой или группу с текстом.");
    figma.closePlugin();
    return;
  }

  const textNodes = collectTextNodes(selection);
  if (textNodes.length === 0) {
    figma.notify("В выделении нет текстовых слоёв.");
    figma.closePlugin();
    return;
  }

  let changedNodes = 0;
  let skippedNodes = 0;

  for (const node of textNodes) {
    try {
      await loadFontsForNode(node);
      const original = node.characters;
      const hyphenated = hyphenateRussianText(original);

      if (hyphenated !== original) {
        node.characters = hyphenated;
        changedNodes += 1;
      }
    } catch (error) {
      skippedNodes += 1;
      console.error(`Не удалось обработать слой ${node.name}`, error);
    }
  }

  if (changedNodes === 0) {
    figma.notify("Переносы уже применены или русских слов не найдено.");
  } else {
    const skippedMessage =
      skippedNodes > 0 ? `, пропущено: ${skippedNodes}` : "";
    figma.notify(`Готово: обработано ${changedNodes} слоёв${skippedMessage}.`);
  }

  figma.closePlugin();
}

run();
