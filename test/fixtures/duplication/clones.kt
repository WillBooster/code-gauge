object Clones {
    // Consistently renamed copy-paste pair: must be detected as one duplicate group.
    fun summarizeOrders(amounts: IntArray, flags: BooleanArray): Double {
        var total = 0.0
        var count = 0
        for (index in amounts.indices) {
            if (flags[index]) {
                total = total + amounts[index]
                count = count + 1
            }
        }
        val average = if (count == 0) 0.0 else total / count
        return average + total + count
    }

    fun summarizeRefunds(values: IntArray, marks: BooleanArray): Double {
        var sum = 0.0
        var seen = 0
        for (position in values.indices) {
            if (marks[position]) {
                sum = sum + values[position]
                seen = seen + 1
            }
        }
        val mean = if (seen == 0) 0.0 else sum / seen
        return mean + sum + seen
    }

    // Same-shape data tables with different values: literal-dense regions must NOT count as clones.
    fun priceTableAlpha(index: Int): Int {
        val values = intArrayOf(101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212, 1313, 1414, 1515, 1616, 1717, 1818, 1919, 2020)
        return values[index]
    }

    fun priceTableBeta(index: Int): Int {
        val values = intArrayOf(111, 222, 333, 444, 555, 666, 777, 888, 999, 1101, 1202, 1303, 1404, 1505, 1606, 1707, 1808, 1909, 2101, 2202)
        return values[index]
    }
}
