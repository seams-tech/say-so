//! Self-contained spoken-English transcript normalization, negation/number guards,
//! 1-word forgiveness on 4+ word sentences, and streaming prefix matching.

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

pub fn is_number_word(word: &str) -> bool {
    NUMBER_WORDS.contains(&word)
}

pub fn is_guarded_word(word: &str) -> bool {
    is_number_word(word) || NEGATION_WORDS.contains(&word)
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

pub fn check_words(transcript: &str, expected: &[String]) -> WordCheck {
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

    let passes = if matched_exact {
        true
    } else if expected.len() >= FORGIVE_MIN_WORDS {
        let dist = edit_distance(&heard_tokens, expected);
        if dist == 1 && heard_tokens.len() <= expected.len() {
            let at = matched_prefix_count;
            let expected_at = expected.get(at).map(String::as_str);
            let heard_at = heard_tokens.get(at).map(String::as_str);
            let guarded_touched = match heard_tokens.len().cmp(&expected.len()) {
                std::cmp::Ordering::Less => expected_at.is_some_and(is_guarded_word),
                std::cmp::Ordering::Equal => {
                    expected_at.is_some_and(is_guarded_word)
                        || heard_at.is_some_and(is_guarded_word)
                }
                std::cmp::Ordering::Greater => true,
            };
            !guarded_touched
        } else {
            false
        }
    } else {
        false
    };

    WordCheck {
        heard: cut_at(&heard_tokens.join(" "), MAX_HEARD_BYTES),
        heard_tokens,
        matched_exact,
        passes,
        matched_prefix_count,
    }
}

fn edit_distance(left: &[String], right: &[String]) -> usize {
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (row, left_word) in left.iter().enumerate() {
        let mut next = Vec::with_capacity(right.len() + 1);
        next.push(row + 1);
        for (column, right_word) in right.iter().enumerate() {
            let substitute = previous[column] + usize::from(left_word != right_word);
            next.push(
                substitute
                    .min(previous[column + 1] + 1)
                    .min(next[column] + 1),
            );
        }
        previous = next;
    }
    previous[right.len()]
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
