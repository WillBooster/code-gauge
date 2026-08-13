package clones

// Consistently renamed copy-paste pair: must be detected as one duplicate group.
func summarizeOrders(amounts []int, flags []bool) int {
	total := 0
	count := 0
	for index, amount := range amounts {
		if flags[index] {
			total = total + amount
			count = count + 1
		}
	}
	average := 0
	if count != 0 {
		average = total / count
	}
	return average + total + count
}

func summarizeRefunds(values []int, marks []bool) int {
	sum := 0
	seen := 0
	for position, value := range values {
		if marks[position] {
			sum = sum + value
			seen = seen + 1
		}
	}
	mean := 0
	if seen != 0 {
		mean = sum / seen
	}
	return mean + sum + seen
}

// Same-shape data tables with different values: literal-dense regions must NOT count as clones.
func priceTableAlpha(index int) int {
	table := []int{101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212, 1313, 1414, 1515, 1616, 1717, 1818, 1919, 2020}
	return table[index]
}

func priceTableBeta(index int) int {
	table := []int{111, 222, 333, 444, 555, 666, 777, 888, 999, 1101, 1202, 1303, 1404, 1505, 1606, 1707, 1808, 1909, 2101, 2202}
	return table[index]
}
