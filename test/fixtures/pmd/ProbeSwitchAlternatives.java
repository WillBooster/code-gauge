class ProbeSwitchAlternatives {
  int colonLabels(int x) {
    switch (x) {
      case 1:
      case 2:
        return 1;
      default:
        return 0;
    }
  }

  int arrowAlternatives(int x) {
    switch (x) {
      case 1, 2 -> {
        return 1;
      }
      default -> {
        return 0;
      }
    }
  }

  int colonAlternatives(int x) {
    switch (x) {
      case 1, 2:
        return 1;
      default:
        return 0;
    }
  }
}
