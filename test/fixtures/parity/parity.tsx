export function classify(items: number[], limit: number): JSX.Element {
  let total = 0;
  for (const item of items) {
    if (item > limit && item % 2 === 0) {
      total += item;
    } else if (item < 0) {
      total -= 1;
    } else {
      total += 1;
    }
  }
  switch (total % 3) {
    case 0:
      return <span>zero</span>;
    case 1:
      return <span>one</span>;
    default:
      return <span>other</span>;
  }
}
