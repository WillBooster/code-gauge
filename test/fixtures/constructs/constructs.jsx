import React, { Component, memo, useState } from 'react';

export class Panel extends Component {
  state = { open: false };

  toggle = () => {
    this.setState((prev) => ({ open: !prev.open }));
  };

  render() {
    const { title, children } = this.props;
    return (
      <section onClick={this.toggle}>
        <h1>{title ?? 'untitled'}</h1>
        {this.state.open && children}
        {this.state.open ? <footer>open</footer> : null}
      </section>
    );
  }
}

export function List({ items, renderItem = (item) => <li key={item}>{item}</li> }) {
  const [filter, setFilter] = useState('');
  return (
    <>
      <input value={filter} onChange={(event) => setFilter(event.target.value)} />
      <ul>
        {items
          .filter((item) => item.includes(filter) || filter === '')
          .map((item) => (item.length > 3 ? renderItem(item) : <li key={item}>short</li>))}
      </ul>
    </>
  );
}

export const Badge = memo(({ count }) => (count > 0 ? <b>{count}</b> : <i>none</i>));

export default function App() {
  return (
    <Panel title="app">
      <List items={['a', 'bb', 'cccc']} />
      <Badge count={2} />
    </Panel>
  );
}
