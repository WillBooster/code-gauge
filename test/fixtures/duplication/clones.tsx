interface CardData {
  amount: number;
  count: number;
  name: string;
  note: string;
  status: string;
}

// Consistently renamed JSX copy-paste pair: the identical markup must form a duplicate group.
export function OrderCard({ order }: { order: CardData }) {
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

export function RefundCard({ refund }: { refund: CardData }) {
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
export function summarizeOrders(orders: CardData[]): number {
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

export function summarizeRefunds(refunds: CardData[]): number {
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
