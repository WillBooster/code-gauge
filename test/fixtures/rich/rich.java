package com.example.rich;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import static java.util.Objects.requireNonNull;
import java.util.function.*;

public class Warehouse {
  public static final int LIMIT = 10;
  private final List<String> items = new ArrayList<>();
  private int counter = 0;

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

  public Warehouse(List<String> seed) {
    for (String item : seed) {
      items.add(item);
    }
  }

  public int receive(Shipment shipment, Map<String, Integer> stock) {
    counter++;
    try {
      if (shipment.quantity() > LIMIT && !items.isEmpty()) {
        items.add(shipment.id());
      } else if (shipment.quantity() < 0 || stock.isEmpty()) {
        throw new IllegalArgumentException("bad shipment " + shipment.id());
      } else {
        switch (shipment.quantity() % 3) {
          case 0 -> items.add("zero");
          case 1 -> items.add("one");
          default -> items.remove(shipment.id());
        }
      }
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
      default -> "other";
    };
  }

  public int drain() {
    int remaining = items.size();
    while (remaining > 0) {
      remaining -= 1;
      do {
        counter += 1;
      } while (counter < 0);
    }
    Runnable hook = new Runnable() {
      @Override
      public void run() {
        items.clear();
      }
    };
    hook.run();
    Function<Integer, Integer> doubler = quantity -> quantity * 2;
    return doubler.apply(remaining);
  }

  public static int fibonacci(int n) {
    return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
  }
}
