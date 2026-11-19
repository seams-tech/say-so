//! Word check (Rule A), summary 1-word forgiveness with negation/number guards,
//! compound-number hyphen normalization for Deepgram Nova-3, and streaming token progress.
use spoken_intent::{
    is_number_word, normalize_punctuated, spoken_text, SpokenAccount, SpokenRequestV1, SpokenToken,
};

pub const MAX_HEARD_BYTES: usize = 200;
const SUMMARY_FORGIVE_MIN_WORDS: usize = 4;

const NEGATION_WORDS: [&str; 34] = [
    "not", "no", "never", "none", "nothing", "neither", "nor", "nobody", "nowhere", "without",
    "cannot", "non", "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "hasnt",
    "havent", "hadnt", "wont", "wouldnt", "cant", "couldnt", "shouldnt", "mustnt", "aint",
    "shant", "neednt", "mightnt", "oughtnt", "darent",
];

const TENS_WORDS: [&str; 8] = [
    "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];
const ONES_WORDS: [&str; 9] = [
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
];

/// Deepgram Nova-3 can hyphenate spoken English compound numbers ("forty-five").
/// Split standalone `<tens>-<ones>` tokens before `normalize_punctuated` so `-` is not
/// read as an account-id `"dash"`.
fn split_compound_number_hyphens(transcript: &str) -> String {
    transcript
        .split_whitespace()
        .map(|raw| {
            let trimmed = raw.trim_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';' | ':'));
            if let Some((left, right)) = trimmed.split_once('-') {
                let l = left.to_ascii_lowercase();
                let r = right.to_ascii_lowercase();
                if TENS_WORDS.contains(&l.as_str()) && ONES_WORDS.contains(&r.as_str()) {
                    return raw.replacen('-', " ", 1);
                }
            }
            raw.to_string()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, PartialEq, Eq)]
pub struct WordCheck {
    pub heard: String,
    pub heard_tokens: Vec<String>,
    pub matched: bool,
    pub distance: Option<usize>,
    pub margin_milli: Option<i32>,
}

pub fn check_words(
    transcript: &str,
    contacts: &[SpokenAccount],
    expected: &[SpokenToken],
    confusions: &[Vec<SpokenToken>],
) -> WordCheck {
    let precleaned = split_compound_number_hyphens(transcript);
    let Ok(tokens) = normalize_punctuated(&precleaned, contacts) else {
        return WordCheck {
            heard: cut_at(&printable(transcript), MAX_HEARD_BYTES),
            heard_tokens: Vec::new(),
            matched: false,
            distance: None,
            margin_milli: None,
        };
    };
    let heard_tokens: Vec<String> = tokens.iter().map(|t| t.as_str().to_string()).collect();
    let heard_words: Vec<&str> = tokens.iter().map(SpokenToken::as_str).collect();
    let expected_words: Vec<&str> = expected.iter().map(SpokenToken::as_str).collect();
    let to_expected = edit_distance(&heard_words, &expected_words);
    let to_near_miss = confusions
        .iter()
        .map(|variant| {
            let words: Vec<&str> = variant.iter().map(SpokenToken::as_str).collect();
            edit_distance(&heard_words, &words)
        })
        .min();
    let margin_milli = match to_near_miss {
        Some(near) if !expected.is_empty() => {
            Some(((near as i64 - to_expected as i64) * 1_000 / expected.len() as i64) as i32)
        }
        _ => None,
    };
    WordCheck {
        heard: cut_at(&spoken_text(&tokens), MAX_HEARD_BYTES),
        heard_tokens,
        matched: tokens.as_slice() == expected,
        distance: Some(to_expected),
        margin_milli,
    }
}

pub fn is_summary_request(request: &SpokenRequestV1) -> bool {
    matches!(
        request,
        SpokenRequestV1::CommunityNote { .. }
            | SpokenRequestV1::Transaction { .. }
            | SpokenRequestV1::SignedMessage { .. }
            | SpokenRequestV1::Confirmation { .. }
    )
}

pub fn words_pass(request: &SpokenRequestV1, check: &WordCheck, expected: &[SpokenToken]) -> bool {
    if check.matched {
        return true;
    }
    let heard: Vec<&str> = check.heard.split_whitespace().collect();
    let at = expected
        .iter()
        .zip(&heard)
        .take_while(|(want, got)| want.as_str() == **got)
        .count();
    let guarded = |word: Option<&str>| {
        word.is_some_and(|w| is_number_word(w) || NEGATION_WORDS.contains(&w))
    };
    let said = expected.get(at).map(SpokenToken::as_str);
    let has_guarded = match heard.len().cmp(&expected.len()) {
        std::cmp::Ordering::Less => guarded(said),
        std::cmp::Ordering::Greater => guarded(heard.get(at).copied()),
        std::cmp::Ordering::Equal => guarded(said) || guarded(heard.get(at).copied()),
    };
    is_summary_request(request)
        && !has_guarded
        && expected.len() >= SUMMARY_FORGIVE_MIN_WORDS
        && check.distance == Some(1)
        && check.margin_milli.is_some_and(|margin| margin > 0)
}

pub fn matched_prefix_count(expected: &[SpokenToken], heard_tokens: &[String]) -> usize {
    expected
        .iter()
        .zip(heard_tokens)
        .take_while(|(want, got)| want.as_str() == got.as_str())
        .count()
}

fn edit_distance(left: &[&str], right: &[&str]) -> usize {
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
