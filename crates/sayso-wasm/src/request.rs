//! Typed `spoken-intent` request parsing for SaySo (`app:<id>` confirmations and NEAR requests).
use serde::{Deserialize, Serialize};
use spoken_intent::{
    multisig_commitment, AppOwner, BetOutcomeV1, ConfirmationContext, NearAccount, NearAmount,
    Network, NoteRatingV1, ProposalV1, SpokenAccount, SpokenBranch, SpokenRequestV1, SpokenSummary,
    UsdcAmount, APP_OWNER_PREFIX,
};

use crate::audio::sha256;
use crate::embedding::from_hex;
use crate::verdict::Reason;

pub const SERVED_NETWORK: Network = Network::Testnet;
pub const MAX_NOTE_CHARS: usize = 280;
pub const MAX_CONTACTS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RatingInput {
    Helpful,
    SomewhatHelpful,
    NotHelpful,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeInput {
    Yes,
    No,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestInput {
    Transfer {
        receiver: String,
        amount_yocto: String,
    },
    CommunityNote {
        contract: String,
        post_id: u64,
        note_text: String,
        summary: String,
    },
    NoteRating {
        contract: String,
        note_id: u64,
        rating: RatingInput,
    },
    MergeApproval {
        contract: String,
        repo_sha256_hex: String,
        pull_request: u64,
        base: String,
        head_commit_hex: String,
    },
    MarketBet {
        market: String,
        token: String,
        market_id: u64,
        outcome: OutcomeInput,
        amount_units: String,
    },
    Transaction {
        receiver: String,
        actions_sha256_hex: String,
        summary: String,
    },
    SignedMessage {
        payload_sha256_hex: String,
        summary: String,
    },
    Confirmation {
        context: String,
        payload_sha256_hex: String,
        summary: String,
    },
    MultisigPropose {
        multisig: String,
        proposal_id: u64,
        receiver: String,
        amount_yocto: String,
    },
    MultisigHideNote {
        multisig: String,
        proposal_id: u64,
        note_id: u64,
    },
    MultisigConfirm {
        multisig: String,
        proposal_id: u64,
        commitment_hex: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredMultisigProposal {
    pub proposal_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_yocto: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<u64>,
    pub salt_hex: String,
}

pub struct BuiltRequest {
    pub request: SpokenRequestV1,
    pub recalled: bool,
    pub contacts: Vec<SpokenAccount>,
    pub multisig_commitment: Option<[u8; 32]>,
    pub multisig_salt: Option<[u8; 32]>,
}

fn unsupported<E>(_: E) -> Reason {
    Reason::Unsupported
}

pub fn parse_yocto(text: &str) -> Option<u128> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u128>().ok()
}

pub fn lowercase_hex<const N: usize>(text: &str) -> Result<[u8; N], Reason> {
    let lowercase = text
        .bytes()
        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    from_hex::<N>(text)
        .filter(|_| lowercase)
        .ok_or(Reason::Unsupported)
}

enum Owner {
    Near(NearAccount),
    App(AppOwner),
}

impl Owner {
    fn parse(text: &str) -> Result<Self, Reason> {
        if text.starts_with(APP_OWNER_PREFIX) {
            AppOwner::new(text).map(Self::App).map_err(unsupported)
        } else {
            NearAccount::new(text).map(Self::Near).map_err(unsupported)
        }
    }
}

fn transfer_proposal(receiver: &str, amount_yocto: u128) -> Result<ProposalV1, Reason> {
    Ok(ProposalV1::Transfer {
        receiver: SpokenAccount::new(receiver).map_err(unsupported)?,
        amount: NearAmount::from_yocto(amount_yocto).map_err(unsupported)?,
    })
}

pub fn build_request(
    owner_text: &str,
    input: &RequestInput,
    contact_strings: &[String],
    salt_hex: Option<&str>,
    stored: Option<&StoredMultisigProposal>,
) -> Result<BuiltRequest, Reason> {
    if contact_strings.len() > MAX_CONTACTS {
        return Err(Reason::Unsupported);
    }
    let owner = match (Owner::parse(owner_text)?, input) {
        (
            Owner::App(owner),
            RequestInput::Confirmation {
                context,
                payload_sha256_hex,
                summary,
            },
        ) => {
            let request = SpokenRequestV1::Confirmation {
                owner,
                context: ConfirmationContext::new(context).map_err(unsupported)?,
                payload_sha256: lowercase_hex::<32>(payload_sha256_hex)?,
                summary: SpokenSummary::new(summary).map_err(unsupported)?,
            };
            let contacts = known_accounts(contact_strings, &request, false)?;
            return Ok(BuiltRequest {
                request,
                recalled: false,
                contacts,
                multisig_commitment: None,
                multisig_salt: None,
            });
        }
        (Owner::App(_), _) | (Owner::Near(_), RequestInput::Confirmation { .. }) => {
            return Err(Reason::Unsupported);
        }
        (Owner::Near(owner), _) => owner,
    };

    let mut recalled = false;
    let mut commitment_out = None;
    let mut salt_out = None;

    let request = match input {
        RequestInput::Transfer {
            receiver,
            amount_yocto,
        } => {
            let receiver = SpokenAccount::new(receiver).map_err(unsupported)?;
            if receiver.as_str() == owner.as_str() {
                return Err(Reason::Unsupported);
            }
            let amount = NearAmount::from_yocto(parse_yocto(amount_yocto).ok_or(Reason::Unsupported)?)
                .map_err(unsupported)?;
            SpokenRequestV1::AccountTransfer {
                network: SERVED_NETWORK,
                owner,
                receiver,
                amount,
            }
        }
        RequestInput::CommunityNote {
            contract,
            post_id,
            note_text,
            summary,
        } => {
            if note_text.trim().is_empty() || note_text.chars().count() > MAX_NOTE_CHARS {
                return Err(Reason::Unsupported);
            }
            SpokenRequestV1::CommunityNote {
                network: SERVED_NETWORK,
                owner,
                contract: NearAccount::new(contract).map_err(unsupported)?,
                post_id: *post_id,
                note_sha256: sha256(note_text.as_bytes()),
                summary: SpokenSummary::new(summary).map_err(unsupported)?,
            }
        }
        RequestInput::NoteRating {
            contract,
            note_id,
            rating,
        } => SpokenRequestV1::NoteRating {
            network: SERVED_NETWORK,
            owner,
            contract: NearAccount::new(contract).map_err(unsupported)?,
            note_id: *note_id,
            rating: match rating {
                RatingInput::Helpful => NoteRatingV1::Helpful,
                RatingInput::SomewhatHelpful => NoteRatingV1::SomewhatHelpful,
                RatingInput::NotHelpful => NoteRatingV1::NotHelpful,
            },
        },
        RequestInput::MergeApproval {
            contract,
            repo_sha256_hex,
            pull_request,
            base,
            head_commit_hex,
        } => {
            if *pull_request == 0 {
                return Err(Reason::Unsupported);
            }
            SpokenRequestV1::MergeApproval {
                network: SERVED_NETWORK,
                owner,
                contract: NearAccount::new(contract).map_err(unsupported)?,
                repo_sha256: lowercase_hex::<32>(repo_sha256_hex)?,
                pull_request: *pull_request,
                base: SpokenBranch::new(base).map_err(unsupported)?,
                head_commit: lowercase_hex::<20>(head_commit_hex)?,
            }
        }
        RequestInput::MarketBet {
            market,
            token,
            market_id,
            outcome,
            amount_units,
        } => {
            if *market_id == 0 {
                return Err(Reason::Unsupported);
            }
            let units = parse_yocto(amount_units).ok_or(Reason::Unsupported)?;
            SpokenRequestV1::MarketBet {
                network: SERVED_NETWORK,
                owner,
                market: NearAccount::new(market).map_err(unsupported)?,
                token: NearAccount::new(token).map_err(unsupported)?,
                market_id: *market_id,
                outcome: match outcome {
                    OutcomeInput::Yes => BetOutcomeV1::Yes,
                    OutcomeInput::No => BetOutcomeV1::No,
                },
                amount: UsdcAmount::from_units(units).map_err(unsupported)?,
            }
        }
        RequestInput::Transaction {
            receiver,
            actions_sha256_hex,
            summary,
        } => SpokenRequestV1::Transaction {
            network: SERVED_NETWORK,
            owner,
            receiver: NearAccount::new(receiver).map_err(unsupported)?,
            actions_sha256: lowercase_hex::<32>(actions_sha256_hex)?,
            summary: SpokenSummary::new(summary).map_err(unsupported)?,
        },
        RequestInput::SignedMessage {
            payload_sha256_hex,
            summary,
        } => SpokenRequestV1::SignedMessage {
            network: SERVED_NETWORK,
            owner,
            payload_sha256: lowercase_hex::<32>(payload_sha256_hex)?,
            summary: SpokenSummary::new(summary).map_err(unsupported)?,
        },
        RequestInput::Confirmation { .. } => return Err(Reason::Unsupported),
        RequestInput::MultisigPropose {
            multisig,
            proposal_id,
            receiver,
            amount_yocto,
        } => {
            if *proposal_id == 0 {
                return Err(Reason::Unsupported);
            }
            let multisig = NearAccount::new(multisig).map_err(unsupported)?;
            let proposal =
                transfer_proposal(receiver, parse_yocto(amount_yocto).ok_or(Reason::Unsupported)?)?;
            let salt = lowercase_hex::<32>(salt_hex.ok_or(Reason::Storage)?)?;
            let commitment = multisig_commitment(&multisig, *proposal_id, &proposal, &salt);
            commitment_out = Some(commitment);
            salt_out = Some(salt);
            SpokenRequestV1::MultisigApproval {
                network: SERVED_NETWORK,
                owner,
                multisig,
                proposal_id: *proposal_id,
                proposal,
                salt,
            }
        }
        RequestInput::MultisigHideNote {
            multisig,
            proposal_id,
            note_id,
        } => {
            if *proposal_id == 0 || *note_id == 0 {
                return Err(Reason::Unsupported);
            }
            let multisig = NearAccount::new(multisig).map_err(unsupported)?;
            let proposal = ProposalV1::HideNote { note_id: *note_id };
            let salt = lowercase_hex::<32>(salt_hex.ok_or(Reason::Storage)?)?;
            let commitment = multisig_commitment(&multisig, *proposal_id, &proposal, &salt);
            commitment_out = Some(commitment);
            salt_out = Some(salt);
            SpokenRequestV1::MultisigApproval {
                network: SERVED_NETWORK,
                owner,
                multisig,
                proposal_id: *proposal_id,
                proposal,
                salt,
            }
        }
        RequestInput::MultisigConfirm {
            multisig,
            proposal_id,
            commitment_hex,
        } => {
            let multisig = NearAccount::new(multisig).map_err(unsupported)?;
            let expected_commitment = lowercase_hex::<32>(commitment_hex)?;
            let stored = stored.ok_or(Reason::ProposalMissing)?;
            if stored.proposal_id != *proposal_id {
                return Err(Reason::ProposalMissing);
            }
            let proposal = match (&stored.receiver, &stored.amount_yocto, stored.note_id) {
                (Some(receiver), Some(amount), None) => transfer_proposal(
                    receiver,
                    parse_yocto(amount).ok_or(Reason::Storage)?,
                )
                .map_err(|_| Reason::Storage)?,
                (None, None, Some(note_id)) => ProposalV1::HideNote { note_id },
                _ => return Err(Reason::Storage),
            };
            let salt = from_hex::<32>(&stored.salt_hex).ok_or(Reason::Storage)?;
            let actual_commitment = multisig_commitment(&multisig, *proposal_id, &proposal, &salt);
            if actual_commitment != expected_commitment {
                return Err(Reason::Storage);
            }
            recalled = true;
            commitment_out = Some(actual_commitment);
            SpokenRequestV1::MultisigApproval {
                network: SERVED_NETWORK,
                owner,
                multisig,
                proposal_id: *proposal_id,
                proposal,
                salt,
            }
        }
    };

    let contacts = known_accounts(contact_strings, &request, recalled)?;
    Ok(BuiltRequest {
        request,
        recalled,
        contacts,
        multisig_commitment: commitment_out,
        multisig_salt: salt_out,
    })
}

fn known_accounts(
    contacts: &[String],
    request: &SpokenRequestV1,
    recalled: bool,
) -> Result<Vec<SpokenAccount>, Reason> {
    let mut accounts = contacts
        .iter()
        .map(|contact| SpokenAccount::new(contact))
        .collect::<Result<Vec<_>, _>>()
        .map_err(unsupported)?;
    let receiver = match request {
        SpokenRequestV1::AccountTransfer { receiver, .. } => Some(receiver),
        SpokenRequestV1::MultisigApproval {
            proposal: ProposalV1::Transfer { receiver, .. },
            ..
        } if !recalled => Some(receiver),
        _ => None,
    };
    if let Some(receiver) = receiver {
        if !accounts.contains(receiver) {
            accounts.push(receiver.clone());
        }
    }
    Ok(accounts)
}
