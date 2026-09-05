package com.example.constructs;

import java.util.ArrayList;
import java.util.List;
import static java.util.Objects.requireNonNull;

public class Warehouse implements Runnable {
  public static final int LIMIT = 10;
  private final List<String> items = new ArrayList<>();
  private int counter;
  static {
    System.setProperty("x", "y");
  }
  {
    counter = 0;
  }

  public record Shipment(String id, int quantity) {
    public Shipment {
      requireNonNull(id);
    }
  }

  public enum Status {
    OPEN,
    CLOSED {
      @Override
      public String label() {
        return "closed";
      }
    };

    public String label() {
      return name().toLowerCase();
    }
  }

  interface Auditor {
    int audit(List<String> items);
    default int twice(List<String> items) {
      return audit(items) * 2;
    }
  }

  @interface Marker {
    String value() default "";
  }

  public Warehouse(List<String> seed) {
    this(seed, 0);
  }

  public Warehouse(List<String> seed, int counter) {
    super();
    for (String item : seed) {
      items.add(item);
    }
    this.counter = counter;
  }

  public int receive(Shipment shipment, int... extras) throws IllegalStateException {
    counter++;
    outer:
    for (int i = 0; i < extras.length; i++) {
      for (int extra : extras) {
        if (extra == i) continue outer;
      }
      synchronized (items) {
        if (shipment.quantity() > LIMIT && !items.isEmpty()) {
          items.add(shipment.id());
        } else if (shipment.quantity() < 0 || items.isEmpty()) {
          throw new IllegalArgumentException("bad shipment " + shipment.id());
        } else {
          switch (shipment.quantity() % 3) {
            case 0 -> items.add("zero");
            case 1, 2 -> items.add("one");
            default -> items.remove(shipment.id());
          }
        }
      }
    }
    try (var reader = new java.io.StringReader("x")) {
      do {
        counter--;
      } while (counter > 0);
      assert counter == 0 : "drained";
    } catch (RuntimeException error) {
      return -1;
    } finally {
      counter--;
    }
    return items.size();
  }

  public String describe(Object value) {
    return switch (value) {
      case Integer number when number > LIMIT -> "big:" + number;
      case Integer number -> "int:" + number;
      case String text -> text.isBlank() ? "blank" : "str:" + text;
      default -> {
        String label = "other";
        yield label;
      }
    };
  }

  @Override
  public void run() {
    Runnable hook = new Runnable() {
      @Override
      public void run() {
        if (items.isEmpty()) items.clear();
      }
    };
    hook.run();
    java.util.function.Function<Integer, Integer> doubler = quantity -> quantity > 0 ? quantity * 2 : 0;
    doubler.apply(counter);
  }

  public static int fibonacci(int n) {
    return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
  }
}
