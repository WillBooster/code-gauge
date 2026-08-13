# Consistently renamed copy-paste pair: must be detected as one duplicate group.
def summarize_orders(orders):
    total = 0
    count = 0
    for order in orders:
        if order.status == 'paid':
            total = total + order.amount
            count = count + 1
    average = 0 if count == 0 else total / count
    return average + total + count


def summarize_refunds(refunds):
    sum_value = 0
    seen = 0
    for refund in refunds:
        if refund.status == 'paid':
            sum_value = sum_value + refund.amount
            seen = seen + 1
    mean = 0 if seen == 0 else sum_value / seen
    return mean + sum_value + seen


# Same-shape data tables with different values: literal-dense regions must NOT count as clones.
def price_table_alpha(index):
    values = [101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212, 1313, 1414, 1515, 1616, 1717, 1818, 1919, 2020]
    return values[index]


def price_table_beta(index):
    values = [111, 222, 333, 444, 555, 666, 777, 888, 999, 1101, 1202, 1303, 1404, 1505, 1606, 1707, 1808, 1909, 2101, 2202]
    return values[index]
