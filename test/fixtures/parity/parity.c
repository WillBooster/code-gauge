const char *classify(const int items[8], int limit) {
  int total = 0;
  for (int i = 0; i < 8; i++) {
    if (items[i] > limit && items[i] % 2 == 0) {
      total += items[i];
    } else if (items[i] < 0) {
      total -= 1;
    } else {
      total += 1;
    }
  }
  switch (total % 3) {
    case 0:
      return "zero";
    case 1:
      return "one";
    default:
      return "other";
  }
}
