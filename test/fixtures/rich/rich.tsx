import React, { memo, useMemo, useState } from 'react';
import { Badge } from './badge.js';

interface ItemProps {
  label: string;
  count: number;
}

export function ItemList({ items }: { items: ItemProps[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const total = useMemo(() => items.reduce((sum, item) => sum + item.count, 0), [items]);
  return (
    <section className="items">
      <button onClick={() => setOpen(!open)} type="button">
        toggle
      </button>
      {open && (
        <ul>
          {items.map((item) => (
            <li key={item.label}>
              <Badge label={item.label} />
              {item.count > 0 ? <strong>{item.count}</strong> : <em>none</em>}
            </li>
          ))}
        </ul>
      )}
      <footer>total: {total}</footer>
    </section>
  );
}

export const Card = memo(function Card({ label, count }: ItemProps) {
  if (count < 0) {
    return null;
  }
  return <div title={label}>{label.repeat(count)}</div>;
});

export const Chip = React.forwardRef<HTMLSpanElement, ItemProps>((props, ref) => (
  <span ref={ref}>{props.label}</span>
));

function buildRows(items: ItemProps[]) {
  return items.map(function Row(item) {
    return React.createElement('tr', { key: item.label }, item.count);
  });
}

export default buildRows;
