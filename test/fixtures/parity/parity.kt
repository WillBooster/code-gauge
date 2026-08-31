fun classify(items: IntArray, limit: Int): String {
    var total = 0
    for (item in items) {
        if (item > limit && item % 2 == 0) {
            total += item
        } else if (item < 0) {
            total -= 1
        } else {
            total += 1
        }
    }
    when (total % 3) {
        0 -> return "zero"
        1 -> return "one"
        else -> return "other"
    }
}
