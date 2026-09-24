class ProbeBooleanPaths {
  boolean initializer(boolean a, boolean b) {
    boolean both = a && b;
    return both || a;
  }

  void condition(boolean a, boolean b) {
    if (a && (b || a)) {
      System.out.println(a);
    }
  }

  int ternaryInCondition(boolean a, boolean b) {
    return (a ? a && b : b) ? 1 : 0;
  }

  int switchOnTernary(boolean a, boolean b) {
    switch (a && b ? 1 : 0) {
      case 1:
        return 1;
      default:
        return 0;
    }
  }

  int guardedPattern(Object o) {
    switch (o) {
      case String s when s.isEmpty() -> {
        return 1;
      }
      case Integer i -> {
        return 2;
      }
      default -> {
        return 0;
      }
    }
  }
}
