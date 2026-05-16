use anchor_lang::prelude::*;

pub mod admin {
    use anchor_lang::{prelude::Pubkey, solana_program::pubkey};

    pub const ADMINS: [Pubkey; 2] = [
        pubkey!("HGSGbiM3tMvbX8cxitEgzbQv53M4rFcsE1gn7fvrHrkN"),
        pubkey!("HGSGbiM3tMvbX8cxitEgzbQv53M4rFcsE1gn7fvrHrkN"),
    ];
}

#[cfg(feature = "local")]
pub fn assert_eq_admin(_admin: Pubkey) -> bool {
    true
}

#[cfg(not(feature = "local"))]
pub fn assert_eq_admin(admin: Pubkey) -> bool {
    crate::admin::admin::ADMINS
        .iter()
        .any(|predefined_admin| predefined_admin.eq(&admin))
}
