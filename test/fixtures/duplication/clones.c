#include <stddef.h>

/* Consistently renamed copy-paste pair: must be detected as one duplicate group. */
static double summarize_orders(const int *amounts, const int *flags, size_t length) {
  double total = 0;
  int count = 0;
  for (size_t index = 0; index < length; index++) {
    if (flags[index] == 1) {
      total = total + amounts[index];
      count = count + 1;
    }
  }
  double average = count == 0 ? 0 : total / count;
  return average + total + count;
}

static double summarize_refunds(const int *values, const int *marks, size_t size) {
  double sum = 0;
  int seen = 0;
  for (size_t position = 0; position < size; position++) {
    if (marks[position] == 1) {
      sum = sum + values[position];
      seen = seen + 1;
    }
  }
  double mean = seen == 0 ? 0 : sum / seen;
  return mean + sum + seen;
}

/* Same-shape data tables with different values: literal-dense regions must NOT count as clones. */
static int price_table_alpha(int index) {
  static const int values[] = {101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212, 1313, 1414, 1515, 1616, 1717, 1818, 1919, 2020};
  return values[index];
}

static int price_table_beta(int index) {
  static const int values[] = {111, 222, 333, 444, 555, 666, 777, 888, 999, 1101, 1202, 1303, 1404, 1505, 1606, 1707, 1808, 1909, 2101, 2202};
  return values[index];
}
