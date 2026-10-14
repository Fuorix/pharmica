/**
 * Matching item names typed in a shop's old system ("PANADOL TAB 500MG", "Panadol 500 mg tabs") against the master
 * list. Names are normalised (case, punctuation, common pharmacy abbreviations, "500 mg" vs "500mg"), then compared
 * by words and by letter triplets. Strengths must agree: "Augmentin 625" is never "Augmentin 1g".
 */

const FORM_WORDS: Record<string, string> = {
  tab: "", tabs: "", tablet: "", tablets: "", cap: "", caps: "", capsule: "", capsules: "",
  syp: "syrup", syr: "syrup", susp: "suspension", inj: "injection", amp: "injection", drp: "drops", drop: "drops",
  oint: "ointment", crm: "cream", sach: "sachet", sachets: "sachet", gm: "g", gms: "g", grams: "g", mgs: "mg"
};

/** Lower-case words with abbreviations expanded and units joined to their numbers. */
export function normaliseName(name: string): string[] {
  const text = name.toLowerCase()
    .replace(/(\d)\s*(mg|mcg|g|gm|gms|ml|iu|%)\b/g, "$1$2")
    .replace(/[^a-z0-9.%]+/g, " ")
    .replace(/(^|\s)\.|\.(\s|$)/g, " ");
  return text.split(/\s+/).map((word) => FORM_WORDS[word] ?? word).filter(Boolean);
}

/** Numbers that make two products different: strengths and pack sizes written in the name. */
function strengths(words: string[]): Set<number> {
  // Compared as numbers, so "625" and "625mg" agree.
  return new Set(words.flatMap((word) => word.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
}

function trigrams(text: string): Map<string, number> {
  const padded = `  ${text} `;
  const grams = new Map<string, number>();
  for (let index = 0; index < padded.length - 2; index++) {
    const gram = padded.slice(index, index + 3);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function dice<T>(a: Map<T, number>, b: Map<T, number>): number {
  let shared = 0;
  let total = 0;
  for (const [key, count] of a) { shared += Math.min(count, b.get(key) ?? 0); total += count; }
  for (const count of b.values()) total += count;
  return total ? 2 * shared / total : 0;
}

const counts = <T>(items: T[]) => items.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map<T, number>());

/** How alike two item names are, from 0 to 1. Different strengths cap the score well below a match. */
export function nameSimilarity(a: string, b: string): number {
  const wordsA = normaliseName(a);
  const wordsB = normaliseName(b);
  if (!wordsA.length || !wordsB.length) return 0;
  const joinedA = wordsA.join(" ");
  const joinedB = wordsB.join(" ");
  if (joinedA === joinedB) return 1;
  // For whole words a strength counts by its number alone, so "625" and "625mg" are the same word.
  const wordKey = (word: string) => /^\d/.test(word) ? String(parseFloat(word)) : word;
  const score = 0.5 * dice(counts(wordsA.map(wordKey)), counts(wordsB.map(wordKey))) + 0.5 * dice(trigrams(joinedA), trigrams(joinedB));
  const strengthA = strengths(wordsA);
  const strengthB = strengths(wordsB);
  const conflicting = strengthA.size > 0 && strengthB.size > 0 && ![...strengthA].some((value) => strengthB.has(value));
  return Math.round((conflicting ? Math.min(score, 0.5) : score) * 1000) / 1000;
}

export interface MatchCandidate<T> {
  item: T;
  score: number;
}

export type MatchVerdict = "matched" | "review" | "none";

/** Above this a name is the same product, provided no other candidate comes close. */
export const AUTO_MATCH_SCORE = 0.9;
/** Below this a candidate is not worth showing. */
export const SUGGEST_SCORE = 0.55;
/** The best candidate must beat the next by this much to be taken without asking. */
const CLEAR_MARGIN = 0.06;

/**
 * The best master-list candidates for a name, and whether a person must decide: a clear, strong match is taken;
 * anything weaker or close to a second candidate goes to review; nothing similar means a new shop item.
 */
export function rankMatches<T>(name: string, items: T[], nameOf: (item: T) => string, limit = 3): { verdict: MatchVerdict; candidates: Array<MatchCandidate<T>> } {
  const candidates = items
    .map((item) => ({ item, score: nameSimilarity(name, nameOf(item)) }))
    .filter((candidate) => candidate.score >= SUGGEST_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const [best, second] = candidates;
  if (!best) return { verdict: "none", candidates };
  const clear = best.score >= AUTO_MATCH_SCORE && (!second || best.score - second.score >= CLEAR_MARGIN);
  return { verdict: clear ? "matched" : "review", candidates };
}
