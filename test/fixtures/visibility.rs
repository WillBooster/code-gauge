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

mod hidden {
    pub fn tucked() -> usize {
        2
    }
}

pub mod surface {
    pub fn reachable() -> usize {
        3
    }

    pub(crate) fn shallow() -> usize {
        4
    }
}

struct Private;

impl Private {
    pub fn helper() -> usize {
        5
    }
}

impl Widget {
    pub fn tag(&self) -> u32 {
        self.id
    }
}

fn outer() -> usize {
    pub fn nested() -> usize {
        6
    }
    nested()
}
