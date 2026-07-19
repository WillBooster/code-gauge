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
  return { total, count, average };
}

function summarizeRefunds(refunds) {
  let total = 0;
  let count = 0;
  for (const refund of refunds) {
    if (refund.status === 'paid') {
      total = total + refund.amount;
      count = count + 1;
    }
  }
  const average = count === 0 ? 0 : total / count;
  return { total, count, average };
}
