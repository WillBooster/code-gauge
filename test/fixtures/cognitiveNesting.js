function classify(items) {
  let total = 0;
  for (const item of items) {
    if (item > 0 && item < 100) {
      if (item % 2 === 0) {
        total += item;
      } else {
        total -= item;
      }
    }
  }
  return total;
}
