# Consistently renamed copy-paste pair: must be detected as one duplicate group.
def summarize_orders(orders)
  total = 0
  count = 0
  orders.each do |order|
    if order[:status] == 'paid'
      total = total + order[:amount]
      count = count + 1
    end
  end
  average = count == 0 ? 0 : total / count
  average + total + count
end

def summarize_refunds(refunds)
  sum = 0
  seen = 0
  refunds.each do |refund|
    if refund[:status] == 'paid'
      sum = sum + refund[:amount]
      seen = seen + 1
    end
  end
  mean = seen == 0 ? 0 : sum / seen
  mean + sum + seen
end

# Same-shape data tables with different values: literal-dense regions must NOT count as clones.
def price_table_alpha(index)
  values = [101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212, 1313, 1414, 1515, 1616, 1717, 1818, 1919, 2020]
  values[index]
end

def price_table_beta(index)
  values = [111, 222, 333, 444, 555, 666, 777, 888, 999, 1101, 1202, 1303, 1404, 1505, 1606, 1707, 1808, 1909, 2101, 2202]
  values[index]
end
