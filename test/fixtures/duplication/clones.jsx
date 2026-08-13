// Consistently renamed JSX copy-paste pair: the identical markup must form a duplicate group.
function OrderCard({ order }) {
  return (
    <article className="card">
      <h2 className="title">{order.name}</h2>
      <p className="line">{order.amount}</p>
      <p className="line">{order.status}</p>
      <span className="badge">{order.count}</span>
      <footer className="footer">{order.note}</footer>
    </article>
  );
}

function RefundCard({ refund }) {
  return (
    <article className="card">
      <h2 className="title">{refund.name}</h2>
      <p className="line">{refund.amount}</p>
      <p className="line">{refund.status}</p>
      <span className="badge">{refund.count}</span>
      <footer className="footer">{refund.note}</footer>
    </article>
  );
}

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
