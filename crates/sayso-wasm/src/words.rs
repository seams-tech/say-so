//! Self-contained spoken-English transcript normalization, negation/number guards,
//! 1-word forgiveness on 4+ word sentences outside the guarded positions of an intent,
//! and streaming prefix matching.

pub const MAX_HEARD_BYTES: usize = 200;
pub const MAX_SENTENCE_WORDS: usize = 16;
const FORGIVE_MIN_WORDS: usize = 4;

const NEGATION_WORDS: [&str; 34] = [
    "not", "no", "never", "none", "nothing", "neither", "nor", "nobody", "nowhere", "without",
    "cannot", "non", "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "hasnt",
    "havent", "hadnt", "wont", "wouldnt", "cant", "couldnt", "shouldnt", "mustnt", "aint",
    "shant", "neednt", "mightnt", "oughtnt", "darent",
];

const NUMBER_WORDS: [&str; 33] = [
    "zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
    "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    "hundred", "thousand", "million", "point",
];

const MONEY_SYMBOLS: [(char, &str, &str); 3] = [
    ('$', "dollar", "dollars"),
    ('\u{20ac}', "euro", "euros"),
    ('\u{a3}', "pound", "pounds"),
];

/// A word that is never forgiven at any position, because one such word changes the meaning.
fn is_number_or_negation_word(word: &str) -> bool {
    NUMBER_WORDS.contains(&word) || NEGATION_WORDS.contains(&word)
}

/// Normalizes a human-written prompt or STT transcript into canonical lowercase spoken tokens.
/// Handles currency (`$45` -> `forty five dollars`), percentages (`10%` -> `ten percent`),
/// decimals (`2.4` -> `two point four`), integers (`0..999_999`), contractions (`don't` -> `dont`),
/// and hyphenated words (`forty-five` -> `forty five`).
pub fn normalize_sentence_tokens(text: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for raw in text.split_whitespace() {
        let trimmed = raw
            .trim_matches(|c: char| matches!(c, ',' | '.' | '!' | '?' | ';' | ':' | '"' | '(' | ')'));
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();

        if let Some((_, one, many)) = MONEY_SYMBOLS.iter().find(|(sym, ..)| lower.starts_with(*sym))
        {
            let rest = &lower[lower.chars().next()?.len_utf8()..];
            let expanded = expand_number_token(rest)?;
            let is_one = rest.replace(',', "").trim_start_matches('0') == "1";
            out.extend(expanded);
            out.push(if is_one { one } else { many }.to_string());
            continue;
        }

        if let Some(rest) = lower.strip_suffix('%') {
            let expanded = expand_number_token(rest)?;
            out.extend(expanded);
            out.push("percent".to_string());
            continue;
        }

        if let Some(expanded) = expand_number_token(&lower) {
            out.extend(expanded);
            continue;
        }

        for piece in lower.split(['-', '/']) {
            if piece.is_empty() {
                continue;
            }
            if let Some(expanded) = expand_number_token(piece) {
                out.extend(expanded);
                continue;
            }
            let cleaned: String = piece
                .chars()
                .filter(|c| c.is_ascii_alphabetic())
                .collect();
            if cleaned.is_empty() {
                return None;
            }
            out.push(cleaned);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn expand_number_token(token: &str) -> Option<Vec<String>> {
    let compact = token.replace(',', "");
    if compact.is_empty() {
        return None;
    }
    if let Some((whole, frac)) = compact.split_once('.') {
        if whole.is_empty()
            || frac.is_empty()
            || !whole.bytes().all(|b| b.is_ascii_digit())
            || !frac.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        let mut out = integer_to_words(whole.parse::<u64>().ok()?)?;
        out.push("point".to_string());
        for b in frac.bytes() {
            out.push(digit_word(b - b'0').to_string());
        }
        return Some(out);
    }
    if !compact.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if compact.len() > 1 && compact.starts_with('0') {
        return Some(
            compact
                .bytes()
                .map(|b| digit_word(b - b'0').to_string())
                .collect(),
        );
    }
    integer_to_words(compact.parse::<u64>().ok()?)
}

fn digit_word(d: u8) -> &'static str {
    match d {
        0 => "zero",
        1 => "one",
        2 => "two",
        3 => "three",
        4 => "four",
        5 => "five",
        6 => "six",
        7 => "seven",
        8 => "eight",
        _ => "nine",
    }
}

fn integer_to_words(n: u64) -> Option<Vec<String>> {
    if n >= 1_000_000 {
        return None;
    }
    if n == 0 {
        return Some(vec!["zero".to_string()]);
    }
    let mut out = Vec::new();
    let thousands = n / 1_000;
    let remainder = n % 1_000;
    if thousands > 0 {
        push_under_thousand(thousands, &mut out);
        out.push("thousand".to_string());
    }
    if remainder > 0 {
        push_under_thousand(remainder, &mut out);
    }
    Some(out)
}

fn push_under_thousand(n: u64, out: &mut Vec<String>) {
    const BELOW_TWENTY: [&str; 20] = [
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
        "nineteen",
    ];
    const TENS: [&str; 10] = [
        "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    let hundreds = n / 100;
    let rem = n % 100;
    if hundreds > 0 {
        out.push(BELOW_TWENTY[hundreds as usize].to_string());
        out.push("hundred".to_string());
    }
    if rem >= 20 {
        out.push(TENS[(rem / 10) as usize].to_string());
        if rem % 10 > 0 {
            out.push(BELOW_TWENTY[(rem % 10) as usize].to_string());
        }
    } else if rem > 0 {
        out.push(BELOW_TWENTY[rem as usize].to_string());
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct WordCheck {
    pub heard: String,
    pub heard_tokens: Vec<String>,
    pub matched_exact: bool,
    pub passes: bool,
    pub matched_prefix_count: usize,
}

/// Compares a transcript with the expected words of an intent.
///
/// Exact words pass. In a sentence of [`FORGIVE_MIN_WORDS`] or more words, one changed or
/// dropped word also passes if [`forgivable_edit`] allows it. `guarded` holds the positions in
/// `expected` that get no forgiveness (`guarded_word_indexes` of the intent).
pub fn check_words(transcript: &str, expected: &[String], guarded: &[u8]) -> WordCheck {
    let Some(heard_tokens) = normalize_sentence_tokens(transcript) else {
        return WordCheck {
            heard: cut_at(&printable(transcript), MAX_HEARD_BYTES),
            heard_tokens: Vec::new(),
            matched_exact: false,
            passes: false,
            matched_prefix_count: 0,
        };
    };

    let matched_prefix_count = expected
        .iter()
        .zip(&heard_tokens)
        .take_while(|(want, got)| want == got)
        .count();
    let matched_exact = heard_tokens == expected;

    let passes = matched_exact
        || (expected.len() >= FORGIVE_MIN_WORDS
            && forgivable_edit(&heard_tokens, expected, matched_prefix_count, guarded));

    WordCheck {
        heard: cut_at(&heard_tokens.join(" "), MAX_HEARD_BYTES),
        heard_tokens,
        matched_exact,
        passes,
        matched_prefix_count,
    }
}

/// Whether `heard` is `expected` with one changed or one dropped word that may be forgiven.
///
/// A number word, a negation word and a word at a guarded position are never forgiven. An
/// added word is never forgiven. `prefix` is the count of leading words that match; the
/// caller passes words that differ, so `prefix` is a position in `expected`.
fn forgivable_edit(heard: &[String], expected: &[String], prefix: usize, guarded: &[u8]) -> bool {
    let guarded_at = |at: usize| guarded.iter().any(|&index| usize::from(index) == at);

    if heard.len() == expected.len() {
        // The first difference is at `prefix`. It is the only one if the rest matches.
        heard[prefix + 1..] == expected[prefix + 1..]
            && !is_number_or_negation_word(&expected[prefix])
            && !is_number_or_negation_word(&heard[prefix])
            && !guarded_at(prefix)
    } else if heard.len() + 1 == expected.len() {
        let suffix = heard
            .iter()
            .rev()
            .zip(expected.iter().rev())
            .take_while(|(got, want)| got == want)
            .count();
        // `heard` is `expected` without the word at any one position from `first` to
        // `prefix`. These positions hold the same word, but each has its own guard.
        let first = expected.len() - 1 - suffix;
        first <= prefix
            && !is_number_or_negation_word(&expected[prefix])
            && !(first..=prefix).any(guarded_at)
    } else {
        false
    }
}

pub fn printable(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '\'' {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn cut_at(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRANSFER: &str = "send ten near to bob dot testnet";
    /// The amount ("ten near") and the recipient ("bob dot testnet").
    const TRANSFER_GUARDS: [u8; 5] = [1, 2, 4, 5, 6];

    fn words(text: &str) -> Vec<String> {
        text.split(' ').map(str::to_string).collect()
    }

    fn passes(heard: &str, expected: &str, guarded: &[u8]) -> bool {
        check_words(heard, &words(expected), guarded).passes
    }

    #[test]
    fn a_changed_or_dropped_word_at_a_guarded_position_refuses() {
        for misheard in [
            "send ten near to rob dot testnet",
            "send ten year to bob dot testnet",
            "send ten near to dot testnet",
            "send ten near to bob dot",
        ] {
            assert!(passes(misheard, TRANSFER, &[]), "no guards: {misheard}");
            assert!(!passes(misheard, TRANSFER, &TRANSFER_GUARDS), "guards: {misheard}");
        }
    }

    #[test]
    fn a_changed_or_dropped_word_outside_the_guards_passes() {
        for heard in [
            TRANSFER,
            "sent ten near to bob dot testnet",
            "ten near to bob dot testnet",
            "send ten near bob dot testnet",
        ] {
            assert!(passes(heard, TRANSFER, &TRANSFER_GUARDS), "{heard}");
        }
        // The number rule still holds at a position without a guard.
        assert!(!passes("send ten near two bob dot testnet", TRANSFER, &TRANSFER_GUARDS));
    }

    #[test]
    fn a_dropped_word_in_a_run_of_equal_words_refuses_if_one_of_them_is_guarded() {
        let expected = "pay amy amy the fee now";
        let heard = "pay amy the fee now";
        assert!(passes(heard, expected, &[]));
        assert!(passes(heard, expected, &[0, 3, 4, 5]));
        assert!(!passes(heard, expected, &[1]));
        assert!(!passes(heard, expected, &[2]));
    }

    /// Levenshtein distance over words, as the reference for [`forgivable_edit`].
    fn edit_distance(left: &[String], right: &[String]) -> usize {
        let mut previous: Vec<usize> = (0..=right.len()).collect();
        for (row, left_word) in left.iter().enumerate() {
            let mut next = vec![row + 1];
            for (column, right_word) in right.iter().enumerate() {
                let substitute = previous[column] + usize::from(left_word != right_word);
                next.push(substitute.min(previous[column + 1] + 1).min(next[column] + 1));
            }
            previous = next;
        }
        previous[right.len()]
    }

    /// With no guarded positions, the words pass exactly when they are at most one
    /// substitution or deletion from the expected words, and that edit touches no number or
    /// negation word.
    #[test]
    fn forgiveness_without_guards_is_one_substitution_or_deletion() {
        const ALPHABET: [&str; 4] = ["pay", "bob", "ten", "not"];
        let mut checked = 0;
        for expected in ["pay bob bob ten", "pay bob pay bob", "not pay pay pay", "bob bob bob bob"] {
            let expected = words(expected);
            for len in 3..=5u32 {
                for code in 0..ALPHABET.len().pow(len) {
                    let heard: Vec<String> = (0..len)
                        .map(|place| ALPHABET[code / ALPHABET.len().pow(place) % ALPHABET.len()])
                        .map(str::to_string)
                        .collect();
                    let at = expected.iter().zip(&heard).take_while(|(w, h)| w == h).count();
                    let touched = |side: &[String]| {
                        side.get(at).is_some_and(|word| is_number_or_negation_word(word))
                    };
                    let reference = heard == expected
                        || (edit_distance(&heard, &expected) == 1
                            && heard.len() <= expected.len()
                            && !touched(&expected)
                            && !(heard.len() == expected.len() && touched(&heard)));
                    let checked_words = check_words(&heard.join(" "), &expected, &[]);
                    assert_eq!(checked_words.passes, reference, "{heard:?} for {expected:?}");
                    checked += 1;
                }
            }
        }
        assert_eq!(checked, 4 * (64 + 256 + 1024));
    }
}
