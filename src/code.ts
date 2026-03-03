import Hypher from "hypher";
import ruPatterns from "hyphenation.ru";

const SOFT_HYPHEN = "\u00AD";
const WORD_JOINER = "\u2060";
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
    .replace(/\u2060-\u200B/g, "") // legacy
    .replace(/-\u200B/g, "") // legacy
    .replace(/\u2060-\n/g, "") // visible mode (hyphen + forced line break)
    .replace(/\u2060/g, ""); // any leftovers
}

function hyphenateWordSoft(word: string): string {
  const clean = stripAllHyphenationMarks(word);
  if (!shouldHyphenateWord(clean)) return clean;

  const parts = hypher.hyphenate(clean);
  if (!parts || parts.length <= 1) return clean;

  // Correct typography: hyphen appears only at actual line breaks.
  return parts.join(SOFT_HYPHEN);
}

function hyphenateTextSoft(text: string): string {
  // Remove any previously inserted marks first to avoid duplicates.
  const clean = stripAllHyphenationMarks(text);

  // Hyphenate sequences of Cyrillic letters.
  return clean.replace(/[А-Яа-яЁё]{5,}/g, (m: string) => hyphenateWordSoft(m));
}

function removeHyphenationMarks(text: string): string {
  return stripAllHyphenationMarks(text);
}

type Measurer = {
  measure: (line: string) => number;
  cleanup: () => void;
};

function getFontForMeasurement(node: TextNode): FontName {
  if (node.characters.length > 0) {
    const f = node.getRangeFontName(0, 1);
    if (f !== figma.mixed) return f;
  }
  if (node.fontName !== figma.mixed) return node.fontName;
  return { family: "Inter", style: "Regular" };
}

function getFontSizeForMeasurement(node: TextNode): number {
  if (node.characters.length > 0) {
    const s = node.getRangeFontSize(0, 1);
    if (typeof s === "number") return s;
  }
  if (node.fontSize !== figma.mixed) return node.fontSize;
  return 12;
}

async function createMeasurer(node: TextNode): Promise<Measurer> {
  const temp = figma.createText();
  figma.currentPage.appendChild(temp);
  temp.visible = false;

  temp.textAutoResize = "WIDTH_AND_HEIGHT";
  const fontName = getFontForMeasurement(node);
  await figma.loadFontAsync(fontName);
  temp.fontName = fontName;
  temp.fontSize = getFontSizeForMeasurement(node);
  temp.characters = " ";

  // These properties exist on TextNode but can be "mixed".
  if ((node as any).letterSpacing !== figma.mixed) (temp as any).letterSpacing = (node as any).letterSpacing;
  if ((node as any).lineHeight !== figma.mixed && (node as any).lineHeight) (temp as any).lineHeight = (node as any).lineHeight;

  const cache = new Map<string, number>();

  const measure = (line: string): number => {
    const cached = cache.get(line);
    if (cached !== undefined) return cached;
    temp.characters = line.length === 0 ? " " : line;
    const w = temp.width;
    cache.set(line, w);
    return w;
  };

  const cleanup = () => {
    try {
      temp.remove();
    } catch {
      // ignore
    }
  };

  return { measure, cleanup };
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e);
}

function tokenizeInline(text: string): string[] {
  // Split into whitespace and non-whitespace tokens (excluding \n which is handled separately).
  return text.match(/[^\S\r\n]+|[^\s]+/g) ?? [];
}

function splitTokenForHyphenation(
  token: string,
): { prefix: string; word: string; suffix: string } | null {
  // Hyphenate only when token contains exactly one Cyrillic word (punctuation allowed around it).
  const m = token.match(/^([^А-Яа-яЁё]*)([А-Яа-яЁё]{5,})([^А-Яа-яЁё]*)$/);
  if (!m) return null;
  return { prefix: m[1], word: m[2], suffix: m[3] };
}

function findBreakByChars(
  currentLine: string,
  prefix: string,
  word: string,
  maxWidth: number,
  measure: (s: string) => number,
): { left: string; right: string } | null {
  // Find the longest prefix of `word` that fits with a hyphen at line end.
  let lo = 1;
  let hi = word.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const left = word.slice(0, mid);
    const candidate = currentLine + prefix + left + "-";
    if (measure(candidate) <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best <= 0) return null;
  return { left: word.slice(0, best), right: word.slice(best) };
}

function findHyphenationSplit(
  currentLine: string,
  token: string,
  maxWidth: number,
  measure: (s: string) => number,
): { leftLine: string; remainderToken: string } | null {
  const parts = splitTokenForHyphenation(token);
  if (!parts) return null;

  const { prefix, word, suffix } = parts;
  const syllables = hypher.hyphenate(word) as string[];
  if (!syllables || syllables.length <= 1) return null;

  let bestIdx = -1;
  let leftWord = "";

  for (let i = 1; i < syllables.length; i++) {
    const candidateLeftWord = syllables.slice(0, i).join("");
    const candidateLine = currentLine + prefix + candidateLeftWord + "-";
    if (measure(candidateLine) <= maxWidth) {
      bestIdx = i;
      leftWord = candidateLeftWord;
    } else {
      break;
    }
  }

  if (bestIdx === -1) {
    const byChars = findBreakByChars(currentLine, prefix, word, maxWidth, measure);
    if (!byChars) return null;
    return {
      leftLine: currentLine + prefix + byChars.left + WORD_JOINER + "-",
      remainderToken: byChars.right + suffix,
    };
  }

  const rightWord = syllables.slice(bestIdx).join("");
  return {
    leftLine: currentLine + prefix + leftWord + WORD_JOINER + "-",
    remainderToken: rightWord + suffix,
  };
}

function wrapWithVisibleHyphens(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string {
  const base = stripAllHyphenationMarks(text);
  const paragraphs = base.split("\n");
  const outParas: string[] = [];

  for (const para of paragraphs) {
    const tokens = tokenizeInline(para);
    let line = "";
    let out = "";

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      if (line.length === 0) {
        if (measure(tok) <= maxWidth) {
          line = tok;
          continue;
        }

        // Too long even for an empty line: try hyphenate within token repeatedly.
        let rest = tok;
        while (rest.length > 0 && measure(rest) > maxWidth) {
          const split = findHyphenationSplit("", rest, maxWidth, measure);
          if (!split) break;
          out += split.leftLine + "\n";
          rest = split.remainderToken;
        }
        line = rest;
        continue;
      }

      if (measure(line + tok) <= maxWidth) {
        line += tok;
        continue;
      }

      const split = findHyphenationSplit(line, tok, maxWidth, measure);
      if (split) {
        out += split.leftLine + "\n";
        line = split.remainderToken;
        continue;
      }

      // Move token to next line (re-process it).
      out += line + "\n";
      line = "";
      i -= 1;
    }

    out += line;
    outParas.push(out);
  }

  return outParas.join("\n");
}

function getBaseTextForNode(node: TextNode): { base: string; shouldStore: boolean } {
  const storedOriginal = node.getPluginData("ruHyph.original");
  const storedLast = node.getPluginData("ruHyph.lastApplied");
  const current = node.characters;

  if (!storedOriginal || !storedLast || current !== storedLast) {
    return { base: stripAllHyphenationMarks(current), shouldStore: true };
  }
  return { base: storedOriginal, shouldStore: false };
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
  let skippedAutoWidth = 0;
  let firstError: string | null = null;

  for (const node of textNodes) {
    try {
      await loadAllFonts(node);
      if (mode === "remove") {
        const original = node.getPluginData("ruHyph.original");
        const next = original ? original : removeHyphenationMarks(node.characters);
        if (next !== node.characters) {
          node.characters = next;
          changed += 1;
        }
        node.setPluginData("ruHyph.original", "");
        node.setPluginData("ruHyph.lastApplied", "");
        continue;
      }

      const { base, shouldStore } = getBaseTextForNode(node);
      if (shouldStore) node.setPluginData("ruHyph.original", base);

      let next: string;
      if (mode === "apply-soft") {
        next = hyphenateTextSoft(base);
      } else {
        // Visible mode: put hyphen ONLY at actual line breaks for the CURRENT width.
        // This works by inserting explicit "\n" after the hyphenation point.
        if (node.textAutoResize === "WIDTH_AND_HEIGHT") {
          skippedAutoWidth += 1;
          next = base; // no wrapping in this mode
        } else {
          const maxWidth = node.width;
          const measurer = await createMeasurer(node);
          try {
            next = wrapWithVisibleHyphens(base, maxWidth, measurer.measure);
          } finally {
            measurer.cleanup();
          }
        }
      }

      if (next !== node.characters) {
        node.characters = next;
        node.setPluginData("ruHyph.lastApplied", next);
        changed += 1;
      }
    } catch (e) {
      if (!firstError) firstError = formatError(e);
      // Also log full error object for dev console.
      console.error(e);
      failed += 1;
    }
  }

  const parts: string[] = [];
  parts.push(
    mode === "remove"
      ? "Готово: удалены переносы (плагина)"
      : mode === "apply-soft"
        ? "Готово: применены мягкие переносы (RU)"
        : "Готово: применены переносы с дефисом (RU) по текущей ширине"
  );
  parts.push(`обработано ${textNodes.length} слоёв`);
  parts.push(`изменено ${changed}`);
  if (skippedAutoWidth > 0) parts.push(`пропущено Auto width ${skippedAutoWidth}`);
  if (failed > 0) parts.push(`ошибок ${failed}`);
  if (failed > 0 && firstError) parts.push(`ошибка: ${firstError}`.slice(0, 80));

  figma.notify(parts.join(", "));
  figma.closePlugin();
}

void main();

