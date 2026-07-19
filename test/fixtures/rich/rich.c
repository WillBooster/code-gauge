#include <stdio.h>
#include <stdlib.h>
#include "local_helpers.h"

#define BUFFER_SIZE 64

enum Mode { MODE_FAST, MODE_SLOW, MODE_AUTO };

struct Record {
  int id;
  double amount;
};

typedef struct Record Record;
typedef struct Node {
  Record record;
  struct Node *next;
} Node;

static int internal_counter = 0;
int global_total = 0;
const int frozen_limit = 10;
int *const frozen_pointer = &global_total;

int classify(int value, enum Mode mode) {
  if (value > 10 && mode != MODE_SLOW) {
    return 1;
  } else if (value < 0 || mode == MODE_AUTO) {
    return -1;
  }
  switch (mode) {
    case MODE_FAST:
      return 2;
    case MODE_SLOW:
      return 3;
    default:
      return 0;
  }
}

int sum_list(const Node *head) {
  int total = 0;
  for (const Node *node = head; node != NULL; node = node->next) {
    total += node->record.id;
  }
  while (total > 100) {
    total /= 2;
  }
  do {
    total += 1;
  } while (total % 2 != 0);
  return total;
}

int fibonacci(int n) {
  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}

int apply(int (*operation)(int), int value) {
  return operation(value);
}

int main(void) {
  char buffer[BUFFER_SIZE];
  Record record = {1, 2.5};
  Node node = {record, NULL};
  internal_counter++;
  global_total = sum_list(&node) + classify(record.id, MODE_AUTO);
  int printed = snprintf(buffer, sizeof buffer, "total=%d\n", global_total);
  if (printed < 0) {
    return EXIT_FAILURE;
  }
  return apply(fibonacci, 5) > 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
