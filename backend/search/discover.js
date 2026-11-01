// Kite Search: finding pages about a search Kite has nothing good for yet.
// KiteBot only knows pages it reached by following links, so a search like
// "how to play guitar" may find nothing about it. Then Kite works out where
// such pages are likely to be, from the search itself (no other search engine
// is asked), and KiteBot reads them first, along with the links on them that
// are about the same thing:
//   - Wikipedia's article on the subject ("Guitar")
//   - wikiHow's article for how-to searches ("Play-Guitar")
//   - Wikibooks (books on a subject) and Wiktionary (a single word)

import { words, fold } from "./text.js";

// The part of a question that names what it's about:
// "How do I make a paper kite that flies well?" -> "make a paper kite".
const LEAD = /^(?:(?:how|what|why|where|when|who|which)\s+(?:do|does|did|can|could|should|would|to|is|are|was|were)?\s*(?:i|you|we|one|it)?\s*(?:to\s+)?|(?:tell me|show me|explain|define)\s+(?:about\s+|how to\s+)?|(?:the\s+)?best\s+way\s+to\s+|ways?\s+to\s+|guide\s+to\s+)/i;
const TAIL = /\s+(?:that|which|so|if|when|while|without|because|for beginners|at home|in \d+.*|step by step|easily|quickly|fast)\b.*$/i;

export function subjectOf(query) {
  let s = String(query || "").replace(/["?!.]+/g, " ").replace(/\bsite:\S+/gi, " ").replace(/\s+/g, " ").trim();
  const howTo = /^how\b|\bhow to\b|^ways? to\b|^best way to\b|^guide to\b/i.test(s);
  for (let i = 0; i < 3; i++) s = s.replace(LEAD, "").trim();
  s = s.replace(TAIL, "").trim().replace(/\b(?:my|your|our)\b/gi, "a");
  return { subject: s.split(" ").slice(0, 7).join(" "), howTo };
}

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
const SMALL = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "with", "your", "my", "at", "by"]);
const SKIP = new Set([...SMALL, "make", "play", "get", "do", "use", "learn", "start", "find", "best", "good", "easy", "how", "what"]);

// Addresses worth reading for this search, best first (at most 10).
export function topicUrls(query) {
  const { subject, howTo } = subjectOf(query);
  if (!subject) return [];
  const typed = String(subject).split(" ").filter(Boolean);
  const content = typed.filter((w) => !SMALL.has(fold(w)));
  const nouns = content.filter((w) => !SKIP.has(fold(w)) && w.length >= 3);
  const urls = [];
  const wiki = (title) => "https://en.wikipedia.org/wiki/" + encodeURIComponent(cap(title.trim()).replace(/ /g, "_")).replace(/%2F/g, "/");
  // wikiHow: "Play-Guitar", "Make-a-Paper-Kite".
  if (howTo && typed.length <= 7) urls.push("https://www.wikihow.com/" + typed.map((w) => (SMALL.has(fold(w)) ? fold(w) : cap(w))).join("-").replace(/^./, (c) => c.toUpperCase()));
  // Wikipedia: the subject's main words as a title, then each word on its own.
  if (nouns.length >= 2) urls.push(wiki(nouns.join(" ").toLowerCase()));
  for (const w of nouns.slice(-3).reverse()) urls.push(wiki(w.toLowerCase()));
  if (!nouns.length && content.length) urls.push(wiki(content.join(" ").toLowerCase()));
  // Wikibooks has textbooks on subjects ("Guitar"); Wiktionary, single words.
  if (howTo) for (const w of nouns.slice(-2).reverse()) urls.push("https://en.wikibooks.org/wiki/" + encodeURIComponent(cap(w.toLowerCase())));
  if (words(query).length === 1) urls.push("https://en.wiktionary.org/wiki/" + encodeURIComponent(fold(query).trim()));
  return [...new Set(urls)].slice(0, 10);
}
