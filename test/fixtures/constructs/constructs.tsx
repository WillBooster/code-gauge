import React, { forwardRef, useCallback, useMemo, useState, type ReactNode } from 'react';

interface RowProps<T> {
  value: T;
  render?: (value: T) => ReactNode;
}

const sizes = ['s', 'm', 'l'] as const;
type Size = (typeof sizes)[number];

export function Row<T extends { id: number }>({ value, render }: RowProps<T>): ReactNode {
  const label = useMemo(() => (render ? render(value) : String(value.id)), [render, value]);
  return <tr data-size={sizes[0] satisfies Size}>{label}</tr>;
}

export const Toggle = forwardRef<HTMLButtonElement, { initial?: boolean }>(function Toggle({ initial = false }, ref) {
  const [on, setOn] = useState(initial);
  const flip = useCallback(() => setOn((previous) => !previous), []);
  return (
    <button ref={ref} onClick={flip} type="button">
      {on ? 'on' : 'off'}
    </button>
  );
});

export class Table<T extends { id: number }> extends React.Component<{ rows: T[] }, { sortDesc: boolean }> {
  state = { sortDesc: false };

  private sorted(): T[] {
    const rows = [...this.props.rows];
    return this.state.sortDesc ? rows.reverse() : rows;
  }

  render(): ReactNode {
    return (
      <table>
        <tbody>
          {this.sorted().map((row) => (
            <Row key={row.id} value={row} render={row.id % 2 === 0 ? undefined : (value) => <em>{value.id}</em>} />
          ))}
        </tbody>
      </table>
    );
  }
}
