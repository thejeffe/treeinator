// Message check for guest requests: what the tree's font can show, and no bad words.
// Not perfect (nothing is), but it catches the usual words, spacing (s h i t), dots (s.h.i.t), letters swapped
// for numbers or symbols (5H1T, $hit, @ss) and stretched letters (shiiit).

export const MAX_LEN = 24;
// The tree's 5x7 font: letters, digits, space and ! ? . , ' - & * + # :   ('<' draws a heart; the page shows it as ♥)
const ALLOWED = /^[A-Z0-9 !?.,'\-&*+#:<]*$/;

// Anywhere in the message (after removing spaces and symbols): long or unmistakable words.
const ANYWHERE = [
  'fuck', 'fuk', 'fck', 'phuck', 'shit', 'sh1t', 'cunt', 'bitch', 'biatch', 'bastard', 'asshole', 'arsehole', 'dickhead',
  'motherf', 'whore', 'slut', 'penis', 'vagina', 'pussy', 'porn', 'nigg', 'nigga', 'faggot', 'fagot', 'retard', 'tranny',
  'kike', 'chink', 'spic', 'wetback', 'coon', 'raghead', 'towelhead', 'hitler', 'nazi', 'heil', 'kkk', 'jizz', 'cumshot',
  'blowjob', 'handjob', 'dildo', 'wank', 'twat', 'bollock', 'boner', 'horny', 'orgasm', 'anal', 'semen', 'clit', 'boob',
  'testicle', 'scrotum', 'killyourself', 'suicide', 'pedo', 'molest', 'isis', 'jihad', 'gangbang', 'milf', 'butthole',
];
// Only as a whole word (they're inside ordinary words: class, cocktail, title, cucumber, grape, sussex, hello).
const WHOLE = [
  'ass', 'arse', 'asses', 'damn', 'hell', 'cock', 'cocks', 'dick', 'dicks', 'tit', 'tits', 'titty', 'cum', 'sex', 'sexy',
  'rape', 'raped', 'fag', 'fags', 'gay', 'homo', 'dyke', 'jap', 'gook', 'kys', 'wtf', 'stfu', 'gtfo', 'fu', 'nut', 'nuts',
  'balls', 'crap', 'piss', 'pissed', 'poop', 'butt', 'hoe', 'hoes', 'thot', 'nude', 'nudes', 'naked', 'kill', 'die',
  'drugs', 'weed', 'meth', 'coke', 'trump', 'biden', 'maga',
];
// Not on a front yard tree either: web addresses, handles and phone numbers.
const SPAM = [/https?/i, /www/i, /\.(com|net|org|io|co|us|ly|gg|tv)\b/i, /@/, /\d[\d\s\-.]{6,}\d/];

const LEET = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g', '6': 'g' };
function deleet(s) { return s.toLowerCase().replace(/[0-9!|@$+]/g, (c) => LEET[c] || c); }
const squeeze = (s) => s.replace(/(.)\1+/g, '$1');            // shiiiit -> shit

// Returns { ok, text } with the message as the tree will show it (upper case), or { ok: false, error }.
export function checkMessage(raw) {
  let text = String(raw == null ? '' : raw).replace(/♥/g, '<').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toUpperCase();
  if (!text) return { ok: true, text: '' };
  if (text.length > MAX_LEN) return { ok: false, error: `Keep the message to ${MAX_LEN} letters.` };
  if (!ALLOWED.test(text)) return { ok: false, error: 'Use letters, numbers and simple punctuation (the tree can’t show other symbols).' };
  for (const re of SPAM) if (re.test(raw)) return { ok: false, error: 'No web addresses or phone numbers, please.' };
  if (isBad(text)) return { ok: false, error: 'Let’s keep it friendly. Try another message.' };
  return { ok: true, text };
}

export function isBad(text) {
  const low = deleet(text);
  const letters = low.replace(/[^a-z]/g, ''), squeezed = squeeze(letters);
  for (const w of ANYWHERE) if (letters.includes(w) || squeezed.includes(squeeze(w))) return true;
  const words = low.split(/[^a-z]+/).filter(Boolean);
  const wholeSet = new Set(WHOLE);
  for (const w of words) if (wholeSet.has(w) || wholeSet.has(squeeze(w))) return true;
  // spaced out: "s h i t", "a s s": single letters in a row, joined
  const runs = low.split(/[^a-z]+/).reduce((acc, w) => { if (w.length === 1) acc[acc.length - 1] += w; else acc.push(''); return acc; }, ['']);
  for (const r of runs) if (r.length >= 2 && (wholeSet.has(r) || wholeSet.has(squeeze(r)) || ANYWHERE.some((w) => r.includes(w)))) return true;
  return false;
}
