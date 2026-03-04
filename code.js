const SOFT_HYPHEN = "\u00AD";
const VOWELS = new Set([
  "а",
  "е",
  "ё",
  "и",
  "о",
  "у",
  "ы",
  "э",
  "ю",
  "я",
  "А",
  "Е",
  "Ё",
  "И",
  "О",
  "У",
  "Ы",
  "Э",
  "Ю",
  "Я"
]);
const NO_BREAK_AFTER = new Set(["ь", "ъ", "й", "Ь", "Ъ", "Й"]);
const NO_BREAK_BEFORE = new Set(["ь", "ъ", "Ь", "Ъ"]);

function isVowel(char) {
  return VOWELS.has(char);
}

function hasAtLeastTwoVowels(word) {
  let count = 0;
  for (const ch of word) {
    if (isVowel(ch)) {
      count += 1;
      if (count >= 2) {
        return true;
      }
    }
  }
  return false;
}

function hasVowelToRight(word, startIndex) {
  for (let i = startIndex; i < word.length; i += 1) {
    if (isVowel(word[i])) {
      return true;
    }
  }
  return false;
}

function hyphenateSegment(segment) {
  if (segment.length < 4 || !hasAtLeastTwoVowels(segment)) {
    return segment;
  }

  const breakPoints = [];
  for (let i = 2; i <= segment.length - 2; i += 1) {
    const prev = segment[i - 1];
    const next = segment[i];

    if (!isVowel(prev)) {
      continue;
    }
    if (!hasVowelToRight(segment, i)) {
      continue;
    }
    if (NO_BREAK_AFTER.has(prev) || NO_BREAK_BEFORE.has(next)) {
      continue;
    }

    breakPoints.push(i);
  }

  if (breakPoints.length === 0) {
    return segment;
  }

  let result = "";
  let breakIndex = 0;

  for (let i = 0; i < segment.length; i += 1) {
    if (breakIndex < breakPoints.length && i === breakPoints[breakIndex]) {
      result += SOFT_HYPHEN;
      breakIndex += 1;
    }
    result += segment[i];
  }

  return result;
}

function hyphenateRussianWord(word) {
  return word
    .split("-")
    .map((part) => hyphenateSegment(part))
    .join("-");
}

function hyphenateRussianText(text) {
  const normalized = text.replace(/\u00AD/g, "");
  return normalized.replace(/[А-Яа-яЁё-]+/g, (token) => {
    if (!/[А-Яа-яЁё]/.test(token)) {
      return token;
    }
    return hyphenateRussianWord(token);
  });
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
