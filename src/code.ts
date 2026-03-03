import Hypher from "hypher";
import ruPatterns from "hyphenation.ru";

const SOFT_HYPHEN = "\u00AD";
const WORD_JOINER = "\u2060";
const ZERO_WIDTH_SPACE = "\u200B";
const VISIBLE_HYPHENATION = `${WORD_JOINER}-${ZERO_WIDTH_SPACE}`; // prevents hyphen moving to next line
const hypher = new Hypher(ruPatterns as any);

function collectTextNodes(nodes: readonly SceneNode[]): TextNode[] {
  const out: TextNode[] = [];

  const walk = (node: SceneNode) => {
    if (node.type === "TEXT") {
      out.push(node);
      return;
    }
    if ("children" in node) {
      for (const child of node.children) walk(child);
    }
  };

  for (const node of nodes) walk(node);
  return out;
}

async function loadAllFonts(node: TextNode) {
  if (node.characters.length === 0) {
    if (node.fontName !== figma.mixed) {
      await figma.loadFontAsync(node.fontName);
    }
    return;
  }

  const fonts = node.getRangeAllFontNames(0, node.characters.length);
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
}

function shouldHyphenateWord(word: string): boolean {
  // Only for Russian words; keep it intentionally simple.
  return word.length >= 5 && /[А-Яа-яЁё]/.test(word);
}

type ApplyMode = "apply-visible" | "apply-soft";

function stripAllHyphenationMarks(text: string): string {
  // Clean up current + legacy variants.
  return text
    .replace(/\u00AD/g, "")
    .replace(/\u2060-\u200B/g, "")
    .replace(/-\u200B/g, "");
}

function hyphenateWord(word: string, mode: ApplyMode): string {
  const clean = stripAllHyphenationMarks(word);
  if (!shouldHyphenateWord(clean)) return clean;

  const parts = hypher.hyphenate(clean);
  if (!parts || parts.length <= 1) return clean;

  if (mode === "apply-soft") {
    // Correct typography: hyphen appears only at actual line breaks.
    return parts.join(SOFT_HYPHEN);
  }

  // Visible workaround for Figma: insert a real hyphen but make it impossible to break BEFORE it.
  // Break can happen AFTER it (via ZWSP), so the hyphen stays at line end and won't move to next line.
  return parts.join(VISIBLE_HYPHENATION);
}

function hyphenateText(text: string, mode: ApplyMode): string {
  // Remove any previously inserted marks first to avoid duplicates.
  const clean = stripAllHyphenationMarks(text);

  // Hyphenate sequences of Cyrillic letters. Words with '-' will be handled as separate parts.
  return clean.replace(/[А-Яа-яЁё]{5,}/g, (m: string) => hyphenateWord(m, mode));
}

function removeHyphenationMarks(text: string): string {
  return stripAllHyphenationMarks(text);
}

async function main() {
  const mode: "remove" | ApplyMode =
    figma.command === "remove"
      ? "remove"
      : figma.command === "apply-soft"
        ? "apply-soft"
        : "apply-visible";
  const selection = figma.currentPage.selection;
  const textNodes = collectTextNodes(selection);

  if (textNodes.length === 0) {
    figma.notify("Выделите текстовый слой (или фрейм/группу с текстом).");
    figma.closePlugin();
    return;
  }

  let changed = 0;
  let failed = 0;

  for (const node of textNodes) {
    try {
      await loadAllFonts(node);
      const next =
        mode === "remove"
          ? removeHyphenationMarks(node.characters)
          : hyphenateText(node.characters, mode);
      if (next !== node.characters) {
        node.characters = next;
        changed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  const parts: string[] = [];
  parts.push(
    mode === "remove"
      ? "Готово: удалены переносы (плагина)"
      : mode === "apply-soft"
        ? "Готово: применены мягкие переносы (RU)"
        : "Готово: применены переносы с дефисом (RU)"
  );
  parts.push(`обработано ${textNodes.length} слоёв`);
  parts.push(`изменено ${changed}`);
  if (failed > 0) parts.push(`ошибок ${failed}`);

  figma.notify(parts.join(", "));
  figma.closePlugin();
}

void main();

