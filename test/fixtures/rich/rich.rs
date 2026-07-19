use std::collections::{BTreeMap, HashMap};
use std::fmt::{self, Display};
use crate::shared::config;

mod storage;

pub const LIMIT: usize = 10;

pub struct Inventory {
    items: HashMap<String, i64>,
    labels: BTreeMap<String, String>,
}

pub enum Command {
    Add(String, i64),
    Remove { key: String },
    Clear,
}

pub trait Auditable {
    fn audit(&self) -> usize;
    fn describe(&self) -> String {
        format!("items: {}", self.audit())
    }
}

impl Inventory {
    pub fn new() -> Self {
        Inventory { items: HashMap::new(), labels: BTreeMap::new() }
    }

    pub fn apply(&mut self, command: Command) -> Result<usize, String> {
        match command {
            Command::Add(key, amount) if amount > 0 => {
                let mut entry = self.items.entry(key).or_insert(0);
                *entry += amount;
                Ok(self.items.len())
            }
            Command::Add(key, _) => Err(format!("invalid amount for {key}")),
            Command::Remove { key } => {
                if self.items.remove(&key).is_some() {
                    Ok(self.items.len())
                } else {
                    Err(String::from("missing key"))
                }
            }
            Command::Clear => {
                self.items.clear();
                while !self.labels.is_empty() {
                    self.labels.pop_first();
                }
                Ok(0)
            }
        }
    }
}

impl Auditable for Inventory {
    fn audit(&self) -> usize {
        self.items.len()
    }
}

impl Display for Inventory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "inventory({})", self.audit())
    }
}

pub fn fibonacci(n: u64) -> u64 {
    if n <= 1 { n } else { fibonacci(n - 1) + fibonacci(n - 2) }
}

pub fn tally(values: &[i64]) -> i64 {
    let double = |value: i64| value * 2;
    let mut total = 0;
    for value in values {
        total += if *value < 0 { -double(*value) } else { double(*value) };
    }
    loop {
        if total < LIMIT as i64 {
            total += 1;
        } else {
            break;
        }
    }
    total + config::offset()
}
