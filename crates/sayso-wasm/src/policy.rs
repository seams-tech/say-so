//! Policy rules applied after speaker and word checks pass.
use spoken_intent::SpokenRequestV1;

#[derive(Debug, PartialEq, Eq)]
pub struct Rule {
    pub id: &'static str,
    pub text: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    StepUp(&'static Rule),
}

const STEP_UP_ABOVE_YOCTO: u128 = 10 * 10u128.pow(24);

pub const STUB_AMOUNT_RULE: Rule = Rule {
    id: "stub_voice_amount_above_10_near",
    text: "A voice payment above 10 NEAR needs a passkey.",
};

pub fn decide(request: &SpokenRequestV1) -> Decision {
    match request {
        SpokenRequestV1::AccountTransfer { amount, .. } if amount.yocto() > STEP_UP_ABOVE_YOCTO => {
            Decision::StepUp(&STUB_AMOUNT_RULE)
        }
        _ => Decision::Allow,
    }
}
