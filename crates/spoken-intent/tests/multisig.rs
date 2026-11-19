//! Checks of the multisig commitment and the request digest of a multisig
//! approval, which the voice multisig contract computes from its own state,
//! and of the salted spoken-text digest of an approval.

pub mod support;

use sha2::{Digest, Sha256};
use spoken_intent::{
    multisig_approval_digest, multisig_commitment, multisig_spoken_text_digest, render,
    request_digest, spoken_text_digest, Network, ProposalV1, SpokenRequestV1,
    MULTISIG_SPOKEN_TEXT_DIGEST_DOMAIN, SPOKEN_TEXT_DIGEST_DOMAIN,
};
use support::{account, near, near_account, MULTISIG_SALT};

fn transfer(hundredths: u64) -> ProposalV1 {
    ProposalV1::Transfer {
        receiver: account("grants.testnet"),
        amount: near(hundredths),
    }
}

fn approval(owner: &str, proposal: ProposalV1, salt: [u8; 32]) -> SpokenRequestV1 {
    SpokenRequestV1::MultisigApproval {
        network: Network::Testnet,
        owner: near_account(owner),
        multisig: near_account("team.testnet"),
        proposal_id: 7,
        proposal,
        salt,
    }
}

#[test]
fn the_digest_binds_the_commitment_and_not_the_proposal() {
    let multisig = near_account("team.testnet");
    let commitment = multisig_commitment(&multisig, 7, &transfer(2_500), &MULTISIG_SALT);
    assert_eq!(
        request_digest(&approval("alice.testnet", transfer(2_500), MULTISIG_SALT)),
        multisig_approval_digest(
            Network::Testnet,
            &near_account("alice.testnet"),
            &multisig,
            7,
            &commitment,
        ),
    );
}

#[test]
fn each_field_changes_the_digest() {
    let base = request_digest(&approval("alice.testnet", transfer(2_500), MULTISIG_SALT));
    let others = [
        approval("bob.testnet", transfer(2_500), MULTISIG_SALT),
        approval("alice.testnet", transfer(250), MULTISIG_SALT),
        approval("alice.testnet", transfer(2_500), [0x5b; 32]),
    ];
    for other in others {
        assert_ne!(request_digest(&other), base, "{other:?}");
    }
}

#[test]
fn the_salt_changes_the_commitment() {
    let multisig = near_account("team.testnet");
    assert_ne!(
        multisig_commitment(&multisig, 7, &transfer(2_500), &MULTISIG_SALT),
        multisig_commitment(&multisig, 7, &transfer(2_500), &[0; 32]),
    );
    assert_ne!(
        multisig_commitment(&multisig, 7, &transfer(2_500), &MULTISIG_SALT),
        multisig_commitment(&multisig, 8, &transfer(2_500), &MULTISIG_SALT),
    );
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// The verdict of an approval is on chain before `execute`. An unsalted
/// digest of its text would let anyone test guesses of the proposal.
#[test]
fn the_spoken_text_digest_of_an_approval_has_the_salt() {
    let request = approval("alice.testnet", transfer(2_500), MULTISIG_SALT);
    let rendered = render(&request);
    let digest = spoken_text_digest(&request, &rendered);
    let text = rendered.spoken_text.as_bytes();
    assert_eq!(
        digest,
        sha256(&[MULTISIG_SPOKEN_TEXT_DIGEST_DOMAIN, text, &MULTISIG_SALT]),
    );
    assert_eq!(digest, multisig_spoken_text_digest(&rendered, &MULTISIG_SALT));
    // The digest that a guess gives without the salt.
    assert_ne!(digest, sha256(&[SPOKEN_TEXT_DIGEST_DOMAIN, text]));
}

#[test]
fn the_salt_changes_the_spoken_text_digest() {
    let request = approval("alice.testnet", transfer(2_500), MULTISIG_SALT);
    let other = approval("alice.testnet", transfer(2_500), [0x5b; 32]);
    let (rendered, other_rendered) = (render(&request), render(&other));
    assert_eq!(rendered.spoken_text, other_rendered.spoken_text);
    assert_ne!(
        spoken_text_digest(&request, &rendered),
        spoken_text_digest(&other, &other_rendered),
    );
}
