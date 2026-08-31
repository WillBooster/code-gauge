pub fn classify(items: &[i32], limit: i32) -> &'static str {
    let mut total = 0;
    for item in items {
        if *item > limit && item % 2 == 0 {
            total += item;
        } else if *item < 0 {
            total -= 1;
        } else {
            total += 1;
        }
    }
    match total % 3 {
        0 => "zero",
        1 => "one",
        _ => "other",
    }
}
