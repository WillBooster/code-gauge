function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

function build(n) {
  const a = factorial(n);
  const b = factorial(n + 1);
  return combine(a, b);
}

function combine(x, y) {
  return x + y;
}
