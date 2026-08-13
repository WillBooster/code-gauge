// Consistently renamed copy-paste pair: must be detected as one duplicate group.
fn summarize_orders(amounts: &[i64], flags: &[bool]) -> i64 {
    let mut total = 0;
    let mut count = 0;
    for (index, amount) in amounts.iter().enumerate() {
        if flags[index] {
            total = total + amount;
            count = count + 1;
        }
    }
    let average = if count == 0 { 0 } else { total / count };
    average + total + count
}

fn summarize_refunds(values: &[i64], marks: &[bool]) -> i64 {
    let mut sum = 0;
    let mut seen = 0;
    for (position, value) in values.iter().enumerate() {
        if marks[position] {
            sum = sum + value;
            seen = seen + 1;
        }
    }
    let mean = if seen == 0 { 0 } else { sum / seen };
    mean + sum + seen
}

// Same-shape data tables with different values: literal-dense regions must NOT count as clones.
fn price_table_alpha(index: usize) -> i32 {
    let values = [101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212, 1313, 1414, 1515, 1616, 1717, 1818, 1919, 2020];
    values[index]
}

fn price_table_beta(index: usize) -> i32 {
    let values = [111, 222, 333, 444, 555, 666, 777, 888, 999, 1101, 1202, 1303, 1404, 1505, 1606, 1707, 1808, 1909, 2101, 2202];
    values[index]
}
