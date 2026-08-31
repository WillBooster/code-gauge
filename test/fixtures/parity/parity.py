def classify(items, limit):
    total = 0
    for item in items:
        if item > limit and item % 2 == 0:
            total += item
        elif item < 0:
            total -= 1
        else:
            total += 1
    match total % 3:
        case 0:
            return "zero"
        case 1:
            return "one"
        case _:
            return "other"
