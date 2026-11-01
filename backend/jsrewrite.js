// Kite's JavaScript rewriter (Stages 5 and 6). No dependencies.
//
// Pages can't be shown their real address any other way: browsers make
// window.location, document.location and window.top impossible to replace. So
// as scripts pass through Kite, every use of those names is renamed:
//
//   location        -> __kite$location          (a variable, or a property: x.location)
//   top             -> __kite$top
//
// and the injected client defines __kite$location / __kite$top on
// Object.prototype: for a window or document they return a stand-in that reports
// the real address (https://www.youtube.com/...) and pretends the Kite tab is the
// top window; for any other object they simply return obj.location / obj.top.
//
// Stage 6: names can also be looked up indirectly (window["loc" + "ation"]), so
// computed lookups are wrapped as well, and so is the code given to eval():
//
//   obj[expr]       -> obj[__kite$k(expr)/*k*/]   ("location" -> "__kite$location")
//   eval(code)      -> eval(__kite$rw(code)/*k*/) (code rewritten the same way)
//
// Only real identifiers are renamed: never text inside strings, comments, regular
// expressions or template text, never object-literal keys or class member names.
// If the rewritten script doesn't parse while the original did, the original is
// used unchanged.

import vm from "node:vm";
import crypto from "node:crypto";

export const RENAMED = ["location", "top"];

// Everything the renamer needs, in one self-contained function, so the same code
// also runs in the browser (the injected client uses it for new Function(...) and
// inline scripts added by JavaScript). It must not use anything from outside.
export function kiteRenamer() {
  const RENAMED = ["location", "top"];
  const PREFIX = "__kite$";

  const KEYWORDS_BEFORE_EXPRESSION = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
    "case", "do", "else", "yield", "await", "extends",
  ]);
  const CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);
  // A "[" after one of these starts an array or a destructuring pattern, not a lookup.
  const NOT_A_VALUE = new Set([...KEYWORDS_BEFORE_EXPRESSION, "else", "var", "let", "const", "export", "default", "import"]);
  const MEMBER_PREAMBLE = new Set(["get", "set", "static", "async", "accessor"]); // { get [k]() {} }
  const KEY_FN = PREFIX + "k"; // obj[expr]   -> obj[__kite$k(expr)]
  const EVAL_FN = PREFIX + "rw"; // eval(code) -> eval(__kite$rw(code))
  // The ")" Kite adds is marked, so the page can be shown its code as it was
  // (fn.toString()) by simply removing what Kite added.
  const CLOSE = ")/*k*/";

  // Punctuators, longest first so ">>>=" wins over ">".
  const PUNCTUATORS = [
    ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
    "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=",
    "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**",
  ];

  const NUMBER = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
  const ID_START_U = /[\\\p{ID_Start}]/u;
  const ID_PART_U = /[\\\u200c\u200d\p{ID_Continue}]/u;
  function isIdStart(c) {
    const k = c.charCodeAt(0);
    return (k >= 97 && k <= 122) || (k >= 65 && k <= 90) || k === 95 || k === 36 || k === 92 || (k > 127 && ID_START_U.test(c));
  }
  function isIdPart(c) {
    const k = c.charCodeAt(0);
    return (k >= 97 && k <= 122) || (k >= 65 && k <= 90) || (k >= 48 && k <= 57) || k === 95 || k === 36 || k === 92 ||
      (k > 127 && ID_PART_U.test(c));
  }

  // Returns [{ start, end, text }] edits for the given source.
  // Stage 6: computed lookups and eval() are wrapped too (unless lookups: false).
  function findRenames(src, names, lookups) {
    const wrapLookups = lookups !== false;
    const wanted = new Set(names || RENAMED);
    const edits = [];
    const n = src.length;
    const stack = []; // { ch: "(" | "[" | "{" | "${", control, kind }
    let prev = null; // { type: "name" | "num" | "str" | "regex" | "punct" | "tmpl", value }
    let lastParenControl = false; // the ")" just closed an if/while/for/with
    let pendingClass = -1; // stack depth where "class" was seen and its "{" is expected
    let declDepth = -1; // stack depth of the var/let/const list we're in, if any
    let evalAt = -1; // position of the "(" of a direct eval call
    let i = 0;

    const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f" ||
      c === "\u00a0" || c === "\ufeff" || c === "\u2028" || c === "\u2029" || (c > "\u1000" && /\s/.test(c));

    // Skip whitespace and comments from j; return the index of the next real character.
    function skip(j) {
      for (;;) {
        while (j < n && isSpace(src[j])) j++;
        if (src[j] === "/" && src[j + 1] === "/") {
          while (j < n && src[j] !== "\n" && src[j] !== "\r" && src[j] !== "\u2028" && src[j] !== "\u2029") j++;
        } else if (src[j] === "/" && src[j + 1] === "*") {
          const e = src.indexOf("*/", j + 2);
          j = e < 0 ? n : e + 2;
        } else if (src[j] === "#" && src[j + 1] === "!" && j === 0) {
          while (j < n && src[j] !== "\n") j++;
        } else return j;
      }
    }

    function regexAllowed() {
      if (!prev) return true;
      if (prev.type === "name") return KEYWORDS_BEFORE_EXPRESSION.has(prev.value);
      if (prev.type !== "punct") return false;
      if (prev.value === ")") return lastParenControl;
      if (prev.value === "]" || prev.value === "++" || prev.value === "--") return false;
      return true; // includes "}" (end of a block, far more common than "{}/x")
    }

    // Template text from j (just after "`" or a "}" closing "${"), up to "`" or "${".
    function scanTemplate(j) {
      while (j < n) {
        const c = src[j];
        if (c === "\\") j += 2;
        else if (c === "`") return { end: j + 1, open: false };
        else if (c === "$" && src[j + 1] === "{") return { end: j + 2, open: true };
        else j++;
      }
      return { end: n, open: false };
    }

    // Is the "[" at i the start of a property lookup (a[b], f()[0], a?.[k])?
    function isLookup() {
      if (!prev) return false;
      if (prev.type === "name") {
        if (prev.property) return true; // a.default[k]: a property name, not a keyword
        if (NOT_A_VALUE.has(prev.value) || prev.binding) return false; // "let x\n[a] = b" is two statements
        const top = stack[stack.length - 1];
        if (MEMBER_PREAMBLE.has(prev.value) && top && top.ch === "{" && top.kind !== "block") return false;
        return true;
      }
      if (prev.type !== "punct") return true; // "str"[i], `t`[i], /x/[k], 1[k]
      if (prev.value === ")") return !lastParenControl;
      if (prev.value === "}") return prev.kind === "object"; // ({ a: 1, b: 2 })[k]
      return prev.value === "]" || prev.value === "?.";
    }
    // a[0], a["name"]: plain keys that can't be "location" or "top" are left alone.
    function plainKey(i) {
      let j = skip(i + 1);
      const c = src[j];
      if (c >= "0" && c <= "9") {
        NUMBER.lastIndex = j;
        if (!NUMBER.exec(src)) return false;
        j = NUMBER.lastIndex;
      } else if (c === "'" || c === '"') {
        let k = j + 1;
        while (k < src.length && src[k] !== c && src[k] !== "\\" && src[k] !== "\n") k++;
        if (src[k] !== c || RENAMED.includes(src.slice(j + 1, k))) return false;
        j = k + 1;
      } else return false;
      return src[skip(j)] === "]";
    }

    // "eval" here names a method or function being defined, not a call.
    function isMethodName() {
      if (!prev) return false;
      if (prev.type === "punct" && (prev.value === "." || prev.value === "?." || prev.value === "#")) return true;
      if (prev.type === "name" && prev.value === "function") return true;
      const top = stack[stack.length - 1];
      return Boolean(top && top.ch === "{" && top.kind !== "block" &&
        ["{", ",", ";", "}", "*", "get", "set", "static", "async"].includes(prev.value));
    }

    function decide(start, end, name) {
      if (prev && prev.type === "punct" && prev.value === "#") return; // #private
      if (prev && prev.type === "name" && (prev.value === "break" || prev.value === "continue")) return; // label
      if (prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.")) {
        edits.push({ start, end, text: PREFIX + name }); // x.location
        return;
      }
      const top = stack[stack.length - 1];
      const next = skip(end);
      const nc = src[next];
      const nc2 = src[next + 1];
      const pv = prev && prev.value;

      // A statement label ("top: for (...)") keeps its name.
      if (nc === ":" && (!prev || [";", "{", "}", ")"].includes(pv))) return;
      // A name in a declaration list: "let left = 0, top = 0" (not object shorthand).
      if (declDepth === stack.length && pv === ",") {
        edits.push({ start, end, text: PREFIX + name });
        return;
      }

      if (top && top.ch === "{" && top.kind === "class") {
        // Class member names (fields, methods, accessors) keep their names.
        if (!prev || ["{", ";", "}", "static", "get", "set", "async", "*", "accessor"].includes(pv)) return;
      }
      if (top && top.ch === "{" && top.kind === "object" && (pv === "{" || pv === ",")) {
        if (nc === ":" ) return; // { location: ... }  key
        if (nc === "(") return; // { location() {} }  method
        if (nc === "," || nc === "}" || (nc === "=" && nc2 !== "=" && nc2 !== ">")) {
          edits.push({ start, end, text: `${name}: ${PREFIX}${name}` }); // { location } shorthand
          return;
        }
      }
      if (top && top.ch === "{" && ["get", "set", "static", "async", "*"].includes(pv) && nc === "(") return;
      edits.push({ start, end, text: PREFIX + name });
    }

    while (i < n) {
      i = skip(i);
      if (i >= n) break;
      const c = src[i];

      // strings
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c) {
          if (src[j] === "\\") j++;
          else if (src[j] === "\n") break; // unterminated; let the syntax check decide
          j++;
        }
        i = j + 1;
        prev = { type: "str" };
        continue;
      }

      // template literals
      if (c === "`") {
        const t = scanTemplate(i + 1);
        i = t.end;
        if (t.open) {
          stack.push({ ch: "${" });
          prev = null;
        } else prev = { type: "tmpl" };
        continue;
      }

      // regular expressions
      if (c === "/" && regexAllowed()) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const d = src[j];
          if (d === "\\") j += 2;
          else if (d === "\n") break;
          else {
            if (d === "[") inClass = true;
            else if (d === "]") inClass = false;
            else if (d === "/" && !inClass) break;
            j++;
          }
        }
        j++;
        while (j < n && isIdPart(src[j])) j++;
        i = j;
        prev = { type: "regex" };
        continue;
      }

      // numbers
      if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(src);
        i = m ? NUMBER.lastIndex : i + 1;
        prev = { type: "num" };
        continue;
      }

      // identifiers and keywords
      if (isIdStart(c)) {
        let j = i + 1;
        while (j < n && isIdPart(src[j])) j++;
        const word = src.slice(i, j);
        if (wanted.has(word)) decide(i, j, word);
        else if (word === "eval" && wrapLookups && src[skip(j)] === "(" && !isMethodName()) {
          evalAt = skip(j); // direct eval: rewrite the code it runs, keep its scope
        }
        if (word === "class" && !(prev && prev.type === "punct" && (prev.value === "." || prev.value === "?."))) {
          const nx = src[skip(j)];
          if (nx !== ":" && nx !== "(" && nx !== "," && nx !== "}") pendingClass = stack.length; // not { class: ... }
        }
        if (word === "var" || word === "let" || word === "const") declDepth = stack.length;
        const binding = declDepth === stack.length && prev &&
          (prev.value === "var" || prev.value === "let" || prev.value === "const" || prev.value === ",");
        const property = Boolean(prev && prev.type === "punct" && (prev.value === "." || prev.value === "?."));
        prev = { type: "name", value: word, binding, property };
        i = j;
        continue;
      }

      // brackets
      if (c === "(" || c === "[" || c === "{") {
        const entry = { ch: c };
        if (c === "(") entry.control = prev && prev.type === "name" && CONTROL_KEYWORDS.has(prev.value);
        if (c === "(" && i === evalAt && src[skip(i + 1)] !== ")") {
          entry.open = { start: i + 1, end: i + 1, text: EVAL_FN + "(" };
          entry.evalCall = true;
          edits.push(entry.open);
        }
        if (c === "[" && wrapLookups && isLookup() && !plainKey(i)) {
          entry.open = { start: i + 1, end: i + 1, text: KEY_FN + "(" };
          edits.push(entry.open);
        }
        if (c === "{") {
          // What comes before "{" tells a block ("if (x) {", "=> {", "; {") from an
          // object literal or destructuring pattern ("= {", "({", ", {", "return {").
          const pv = prev && prev.value;
          if (pendingClass === stack.length) entry.kind = "class";
          else if (!prev && stack.length && stack[stack.length - 1].ch === "${") entry.kind = "object"; // `${{ a: 1 }[k]}`
          else if (!prev || (prev.type === "punct" && [")", "{", "}", ";", "=>"].includes(pv)) ||
            (prev.type === "name" && ["else", "do", "try", "finally"].includes(pv))) entry.kind = "block";
          else entry.kind = "object";
          pendingClass = -1;
        }
        stack.push(entry);
        prev = { type: "punct", value: c };
        i++;
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        const entry = stack.pop();
        if (c === "}" && entry && entry.ch === "${") {
          const t = scanTemplate(i + 1); // back into template text
          i = t.end;
          if (t.open) {
            stack.push({ ch: "${" });
            prev = null;
          } else prev = { type: "tmpl" };
          continue;
        }
        if (entry && entry.open && !entry.closed) {
          edits.push({ start: i, end: i, text: CLOSE });
          if (entry.comma) entry.open.text += "(", edits[edits.length - 1].text = ")" + CLOSE;
        }
        lastParenControl = c === ")" && Boolean(entry && entry.control);
        if (declDepth > stack.length) declDepth = -1;
        prev = { type: "punct", value: c, kind: entry && entry.kind };
        i++;
        continue;
      }

      // other punctuation
      let p = c;
      for (const op of PUNCTUATORS) {
        if (src.startsWith(op, i)) {
          p = op === "?." && src[i + 2] >= "0" && src[i + 2] <= "9" ? "?" : op;
          break;
        }
      }
      if (p === ",") {
        const top = stack[stack.length - 1];
        if (top && top.open && !top.closed) {
          if (top.evalCall) {
            edits.push({ start: i, end: i, text: CLOSE }); // eval(code, more): only code is rewritten
            top.closed = true;
          } else top.comma = true; // a[b, c]: keep it one expression
        }
      }
      if (p === ";" && pendingClass > stack.length) pendingClass = -1;
      if (p === ";" && declDepth === stack.length) declDepth = -1;
      prev = { type: "punct", value: p };
      i += p.length;
    }
    return edits;
  }

  function applyEdits(src, edits) {
    if (!edits.length) return src;
    let out = "";
    let last = 0;
    for (const e of edits) {
      out += src.slice(last, e.start) + e.text;
      last = e.end;
    }
    return out + src.slice(last);
  }

  return { findRenames, applyEdits };
}

export const { findRenames, applyEdits } = kiteRenamer();

function parses(code, asFunctionBody) {
  try {
    new vm.Script(asFunctionBody ? `(function(event){${code}\n})` : code);
    return true;
  } catch (err) {
    return err && /import statement|export|import\.meta|await is only valid/i.test(String(err.message)) ? null : false;
  }
}

// Rewrite a script. asFunctionBody: an event-handler attribute (onclick="...").
// Returns the original if nothing needs renaming or the result doesn't parse.
export function rewriteJsUncached(src, { asFunctionBody = false } = {}) {
  if (!src.includes("[") && !src.includes("eval") && !RENAMED.some((name) => src.includes(name))) return src;
  const edits = findRenames(src);
  if (!edits.length) return src;
  const out = applyEdits(src, edits);
  const before = parses(src, asFunctionBody);
  if (before === true && parses(out, asFunctionBody) !== true) return src; // safety net
  return out;
}

// Small cache: big sites send the same multi-megabyte scripts on every page.
const cache = new Map();
let cacheBytes = 0;
const CACHE_LIMIT = 64 * 1024 * 1024;

// KITE_JS_REWRITE=0 turns Stage 5's script rewriting off (for finding out whether
// a broken page is caused by it).
// (Kite DevTools can switch it while Kite runs.)
export const rewriteSettings = { on: typeof process === "undefined" || process.env.KITE_JS_REWRITE !== "0" };

export function cacheStats() {
  return { entries: cache.size, bytes: cacheBytes };
}

export function rewriteJs(src, options = {}) {
  if (!rewriteSettings.on) return src;
  if (src.length < 2048) return rewriteJsUncached(src, options);
  const key = (options.asFunctionBody ? "f:" : "s:") + crypto.createHash("sha1").update(src).digest("base64");
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key); // most recently used goes last
    cache.set(key, hit);
    return hit;
  }
  const out = rewriteJsUncached(src, options);
  cache.set(key, out);
  cacheBytes += out.length;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_LIMIT) break;
    cache.delete(k);
    cacheBytes -= v.length;
  }
  return out;
}
