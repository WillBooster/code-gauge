use std::collections::HashMap;
use std::fmt::{self, Display};

pub const LIMIT: usize = 10;
static COUNTER: usize = 0;

pub struct Inventory {
    items: HashMap<String, i64>,
    label: String,
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
    pub fn new(label: &str) -> Self {
        Inventory { items: HashMap::new(), label: label.to_string() }
    }

    pub fn apply(&mut self, command: Command, limit: i64) -> Result<usize, String> {
        let outcome = match command {
            Command::Add(key, amount) if amount > 0 => {
                let entry = self.items.entry(key).or_insert(0);
                *entry += amount;
                Ok(self.items.len())
            }
            Command::Add(key, _) => Err(format!("invalid amount for {key}")),
            Command::Remove { key } => {
                if let Some(value) = self.items.remove(&key) {
                    if value > limit && value % 2 == 0 {
                        Ok(self.items.len())
                    } else {
                        Err(String::from("odd"))
                    }
                } else if key.is_empty() || limit < 0 {
                    Err(String::from("empty"))
                } else {
                    Err(String::from("missing key"))
                }
            }
            Command::Clear => {
                self.items.clear();
                'outer: loop {
                    while let Some((key, _)) = self.items.iter().next() {
                        if key.is_empty() {
                            break 'outer;
                        }
                    }
                    break;
                }
                Ok(0)
            }
        };
        let doubled = |value: usize| value * 2;
        outcome.map(doubled)
    }
}

impl Display for Inventory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "inventory({})", self.items.len())
    }
}

pub fn tally(values: &[i64]) -> Result<i64, String> {
    let mut total = 0;
    for value in values {
        total += if *value < 0 { -value } else { *value };
    }
    let first = values.first().ok_or("empty")?;
    Ok(total + first)
}

pub fn countdown(n: u64) -> u64 {
    if n <= 1 { n } else { countdown(n - 1) }
}

macro_rules! square {
    ($x:expr) => {
        $x * $x
    };
}
