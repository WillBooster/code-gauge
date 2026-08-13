pub use std::fmt;

pub const LIMIT: usize = 8;

pub(crate) struct Widget {
    pub id: u32,
    label: String,
}

pub fn shared() -> usize {
    LIMIT
}

fn internal() -> usize {
    shared()
}

pub(super) enum Kind {
    Simple,
}
