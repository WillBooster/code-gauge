#include <stdio.h>
#include <stdlib.h>
#include "local.h"

#define BUFFER_SIZE 64
#define SQUARE(x) ((x) * (x))

#ifdef DEBUG
static int debug_level = 1;
#else
static int debug_level = 0;
#endif

enum Mode { MODE_FAST, MODE_SLOW, MODE_AUTO };

struct Record {
  int id;
  double amount;
};

union Value {
  int number;
  char text[BUFFER_SIZE];
};

typedef struct Record Record;
typedef int (*Operation)(int);

static int internal_counter = 0;
int global_total = 0, secondary_total = 1;

static inline int square(int value) { return SQUARE(value); }

int classify(int value, enum Mode mode) {
  int total = 0;
  for (int i = 0; i < value; i++) {
    for (int j = 0; j < i; j++) {
      if (i == j) goto skip;
    }
    if (i > 10 && mode != MODE_SLOW) {
      total += i;
    } else if (i < 0 || mode == MODE_AUTO) {
      total -= 1;
    } else {
      total += 1;
    }
  skip:
    continue;
  }
  while (total > 100) {
    total /= 2;
  }
  do {
    total += 1;
  } while (total % 2 != 0 && total < 1000);
  switch (mode) {
    case MODE_FAST:
      return total > 0 ? 2 : -2;
    case MODE_SLOW:
    case MODE_AUTO:
      return 3;
    default:
      return 0;
  }
}

int sum_list(const Record *records, size_t count) {
  int total = 0;
  for (size_t i = 0; i < count; i++) {
    total += records[i].id;
  }
  return total;
}

int fibonacci(int n) {
  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}

int apply(Operation operation, int value, ...) {
  return operation(value);
}

int main(void) {
  char buffer[BUFFER_SIZE];
  Record record = {1, 2.5};
  union Value value;
  value.number = square(record.id);
  internal_counter++;
  global_total = sum_list(&record, 1) + classify(record.id, MODE_AUTO);
  int printed = snprintf(buffer, sizeof buffer, "total=%d\n", global_total + value.number);
  if (printed < 0) {
    return EXIT_FAILURE;
  }
  return apply(fibonacci, 5) > 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
