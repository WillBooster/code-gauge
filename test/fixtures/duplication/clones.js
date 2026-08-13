// Consistently renamed copy-paste pair: must be detected as one duplicate group.
function summarizeOrders(orders) {
  let total = 0;
  let count = 0;
  for (const order of orders) {
    if (order.status === 'paid') {
      total = total + order.amount;
      count = count + 1;
    }
  }
  const average = count === 0 ? 0 : total / count;
  return average + total + count;
}

function summarizeRefunds(refunds) {
  let sum = 0;
  let seen = 0;
  for (const refund of refunds) {
    if (refund.status === 'paid') {
      sum = sum + refund.amount;
      seen = seen + 1;
    }
  }
  const mean = seen === 0 ? 0 : sum / seen;
  return mean + sum + seen;
}

// Same-shape data tables with different values: literal-dense regions must NOT count as clones.
function priceTableAlpha(index) {
  const values = [101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212, 1313, 1414, 1515, 1616, 1717, 1818, 1919, 2020];
  return values[index];
}

function priceTableBeta(index) {
  const values = [111, 222, 333, 444, 555, 666, 777, 888, 999, 1101, 1202, 1303, 1404, 1505, 1606, 1707, 1808, 1909, 2101, 2202];
  return values[index];
}
