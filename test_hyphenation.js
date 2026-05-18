// Node.js test for hyphenation logic.
// Part 1: unit tests for findBestBreakInToken.
// Part 2: integration test via the actual src/code.js functions
//         loaded through a lightweight Figma mock + vm.

const Hypher = require("hypher");
const russianPatterns = require("hyphenation.ru");
const hypher = new Hypher(russianPatterns);
const vm  = require("vm");
const fs  = require("fs");

// ── Constants (mirrors src/code.js) ─────────────────────────────────────────
const ZERO_WIDTH_SPACE    = "​";
const INSERTED_BREAK_MARKER = `-${ZERO_WIDTH_SPACE}`;
const NBSP                = " ";
const TOKEN_REGEX         = /(\n|[^\S\n ]+|(?:[^\s]| )+)/g;
const SPACE_TOKEN_REGEX   = /^[^\S\n ]+$/;
const RUSSIAN_TOKEN_REGEX = /^([^А-ЯЁа-яё-]*)([А-ЯЁа-яё]+)([^А-ЯЁа-яё-]*)$/;
const WIDTH_EPSILON       = 0.01;

// ── Pixel-accurate measureWidth (monospace 10px per char, 3px per space) ────
function makeMeasureWidth(charPx = 10, spacePx = 3) {
  return function measureWidth(text) {
    let w = 0;
    for (const ch of text) {
      if (ch === " " || ch === NBSP) w += spacePx;
      else if (ch === ZERO_WIDTH_SPACE) { /* zero */ }
      else w += charPx;
    }
    return w;
  };
}
const measureWidth = makeMeasureWidth(10, 3);

// ── Thin wrapper around hypher ───────────────────────────────────────────────
function findBestBreakInToken(token, remainingWidth, options) {
  const minWordLength = options?.minWordLengthForHyphenation ?? 4;
  const minBefore     = options?.minLettersBeforeHyphen ?? 2;
  const minAfter      = options?.minLettersAfterHyphen  ?? 3;

  const match = token.match(RUSSIAN_TOKEN_REGEX);
  if (!match) return null;
  const [, leading, core, trailing] = match;
  if (core.length < minWordLength) return null;

  const parts = hypher.hyphenate(core);
  if (!parts || parts.length <= 1) return null;

  for (let i = parts.length - 1; i >= 1; i--) {
    const leftCore  = parts.slice(0, i).join("");
    const rightCore = parts.slice(i).join("");
    if (leftCore.length < minBefore || rightCore.length < minAfter) continue;
    const leftWithDash = `${leading}${leftCore}-`;
    if (measureWidth(leftWithDash) <= remainingWidth + WIDTH_EPSILON) {
      return { left: `${leading}${leftCore}`, right: `${rightCore}${trailing}` };
    }
  }
  return null;
}

// ── Unit tests: findBestBreakInToken ────────────────────────────────────────
const UNIT_OPTS = { minLettersBeforeHyphen: 3, minLettersAfterHyphen: 3, minWordLengthForHyphenation: 4 };

function testBreak(word, availablePx, expected) {
  const r = findBestBreakInToken(word, availablePx, UNIT_OPTS);
  const got = r ? `${r.left}-|${r.right}` : "null";
  const pass = expected === null ? r === null : (r !== null && r.left === expected.split("|")[0] && r.right === expected.split("|")[1]);
  console.log(`${pass ? "✓" : "✗"} findBestBreak("${word}", ${availablePx}px) → ${got}  ${pass ? "" : `expected: ${expected}`}`);
}

console.log("\n── Unit: findBestBreakInToken ──────────────────────────────────");
// "отрывая": hypher = от-ры-вая. Best fit in 50px: "отры-" (4×10+10=50) → "отры|вая"
testBreak("отрывая",       50, "отры|вая");
// "количественный": hypher выбирает "количе-|ственный" (7 chars left fits in 90px)
testBreak("количественный", 90, "количе|ственный");
// "параллельно": "парал-|лельно" (5 chars × 10 + 10 = 60 ≤ 70)
testBreak("параллельно",   70, "парал|лельно");
// "рост": 4 chars but no syllable split with min 3+3
testBreak("рост",          99, null);
// "старайтесь": "старай-|тесь" (6×10+10=70)
testBreak("старайтесь",    70, "старай|тесь");
// Слишком мало места
testBreak("заваливаться",  20, null);
// "медленно": "мед-|ленно" (3×10+10=40)
testBreak("медленно",      40, "мед|ленно");
// "заваливаться" с 80px доступных
testBreak("заваливаться",  80, "завали|ваться");

// ── Integration: load actual processOneParagraph via VM ─────────────────────
// We mock figma.* so the module body executes without crashing.
// Functions defined in the file are accessible because vm.runInNewContext
// shares the mocked context.

let processOneParagraph = null;

try {
  const src = fs.readFileSync("./src/code.js", "utf8");

  // Patch: add module.exports of the function we need at the END of the source.
  const patched = src + `
if (typeof processOneParagraph === 'function') {
  _testExports.processOneParagraph = processOneParagraph;
}
`;

  const _testExports = {};
  const mockFigma = {
    on: () => {},
    off: () => {},
    currentPage: { selection: [] },
    ui: { onmessage: null, postMessage: () => {} },
    clientStorage: { getAsync: async () => null, setAsync: async () => {} },
    showUI: () => {},
    closePlugin: () => {},
    notify: () => {},
    getNodeById: () => null,
  };

  const ctx = vm.createContext({
    require,
    console,
    module: { exports: {} },
    exports: {},
    figma: mockFigma,
    __html__: "<div></div>",
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Object, Array, Set, Map, RegExp, Error, String,
    _testExports,
  });

  vm.runInContext(patched, ctx, { filename: "src/code.js" });
  processOneParagraph = _testExports.processOneParagraph;
} catch (e) {
  console.error("VM load failed:", e.message.split("\n")[0]);
}

// ── Integration tests ────────────────────────────────────────────────────────
if (typeof processOneParagraph === "function") {
  console.log("\n── Integration: processOneParagraph (actual src/code.js) ──────");

  // maxWidth in pixels. Use same char metric so it's consistent.
  // A ~430px column at 10px/char ≈ 43 chars wide.
  const MAX_W = 430;
  const mw = measureWidth;
  const opts = {
    minLettersBeforeHyphen: 3,
    minLettersAfterHyphen: 3,
    minWordLengthForHyphenation: 4,
    preventOrphans: true,
  };

  function renderLines(text) {
    const lines = [];
    let cur = "";
    // Normalise NBSP to regular space for display only
    const display = t => t.replace(/ /g, " ");
    for (const tok of (text.match(TOKEN_REGEX) || [])) {
      if (tok.includes(ZERO_WIDTH_SPACE)) {
        cur += display(tok).replace(ZERO_WIDTH_SPACE, "");
        lines.push(cur.trim()); cur = "";
      } else if (SPACE_TOKEN_REGEX.test(tok)) {
        /* skip — we add spaces between words ourselves */
      } else {
        const word = display(tok);
        const cand = cur ? cur + " " + word : word;
        if (cur && mw(cand) > MAX_W) { lines.push(cur.trim()); cur = word; }
        else cur = cand;
      }
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines;
  }

  function runTest(label, text, maxConsec = 3) {
    const res   = processOneParagraph(text, MAX_W, mw, opts, 0, maxConsec);
    const lines = renderLines(res.text);
    console.log(`\n  ▸ ${label}`);
    console.log(`    breaks=${res.breakCount}  unsolvedSparse=${res.unsolvedSparseLines}`);
    for (const [i, line] of lines.entries()) {
      const isLast = i === lines.length - 1;
      const fill   = mw(line.replace(/-$/, "")) / MAX_W;
      const sparse = !isLast && fill < 0.75 ? " ⚠ SPARSE" : "";
      console.log(`    L${i+1} fill=${(fill*100).toFixed(0)}%${sparse}  "${line}"`);
    }
  }

  runTest(
    "4 слова — должен разбить (look-back)",
    "опускайтесь обратно, не отрывая в конечной точке пальцы от пола."
  );

  runTest(
    "5 слов — В верхней же точке",
    "В верхней же точке старайтесь не заваливаться на мизинцы и держать."
  );

  runTest(
    "Полный абзац (скриншот 1)",
    "Встаньте в исходную позицию: ноги на ширине таза, стопы параллельно другу, корпус ровный. Поднимайтесь на носки, больше ощущая в опоре первые три пальца, и медленно опускайтесь обратно, не отрывая в конечной точке пальцы от пола. В верхней же точке старайтесь не заваливаться на мизинцы и держать пятки параллельно друг другу."
  );

  runTest(
    "Абзац с тире (скриншот 2)",
    "Выполняйте этот небольшой комплекс каждое утро или в обеденный перерыв, и уже через несколько дней вы почувствуете, как уходит скованность, а энергия возвращается. Самое важное — не пытаться наверстать упущенное за один день и не корить себя за праздничные послабления."
  );

  runTest(
    "7 коротких слов (look-back до 7)",
    "обратите внимание на движение, если вы действуете без насилия — это правильно."
  );

} else {
  console.log("\nVM интеграция недоступна — только unit тесты запущены.");
}
