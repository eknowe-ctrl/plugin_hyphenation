import Hypher from "hypher";
import ruPatterns from "hyphenation.ru";

const SOFT_HYPHEN = "\u00AD";
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

function hyphenateWord(word: string): string {
  const clean = word.replace(/\u00AD/g, "");
  if (!shouldHyphenateWord(clean)) return clean;

  const parts = hypher.hyphenate(clean);
  if (!parts || parts.length <= 1) return clean;

  return parts.join(SOFT_HYPHEN);
}

function hyphenateText(text: string): string {
  // Remove any previously inserted soft hyphens first to avoid duplicates.
  const clean = text.replace(/\u00AD/g, "");

  // Hyphenate sequences of Cyrillic letters. Words with '-' will be handled as separate parts.
  return clean.replace(/[А-Яа-яЁё]{5,}/g, (m: string) => hyphenateWord(m));
}

function removeSoftHyphens(text: string): string {
  return text.replace(/\u00AD/g, "");
}

async function main() {
  const mode: "apply" | "remove" = figma.command === "remove" ? "remove" : "apply";
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
          ? removeSoftHyphens(node.characters)
          : hyphenateText(node.characters);
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
    mode === "remove" ? "Готово: удалены мягкие переносы" : "Готово: применены переносы (RU)"
  );
  parts.push(`обработано ${textNodes.length} слоёв`);
  parts.push(`изменено ${changed}`);
  if (failed > 0) parts.push(`ошибок ${failed}`);

  figma.notify(parts.join(", "));
  figma.closePlugin();
}

void main();

