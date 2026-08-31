package parity

func classify(items []int, limit int) string {
	total := 0
	for _, item := range items {
		if item > limit && item%2 == 0 {
			total += item
		} else if item < 0 {
			total -= 1
		} else {
			total += 1
		}
	}
	switch total % 3 {
	case 0:
		return "zero"
	case 1:
		return "one"
	default:
		return "other"
	}
}
