#include <map>
#include <string>
#include <vector>
#include "engine/parts.hpp"

namespace machine {

constexpr int kLimit = 10;
inline int shared_total = 0;
using Table = std::map<std::string, int>;
namespace alias = std;

enum class Gear { Low, High };

template <typename T>
concept Numeric = std::is_arithmetic_v<T>;

template <typename T>
class Engine {
 public:
  explicit Engine(T base) : base_(base) {}
  virtual ~Engine() = default;
  virtual T boost(T amount) const = 0;
  T base() const { return base_; }
  friend class Widget;
  static_assert(sizeof(T) > 0, "non-empty");

 protected:
  T base_;
};

class Widget : public Engine<int> {
 public:
  Widget() : Widget(0) {}
  explicit Widget(int size) try : Engine(size), size_(size) {
  } catch (...) {
  }
  int boost(int amount) const override { return base() + amount; }
  bool operator==(const Widget& other) const { return size_ == other.size_; }
  operator int() const { return size_; }
  int size() const;

 private:
  int size_;
};

int Widget::size() const { return size_; }

int classify(int value, Gear gear, ...) {
  int total = 0;
  for (int i = 0; i < value; i++) {
    for (int j : {1, 2}) {
      if (i == j) goto next;
    }
    if (i > kLimit and gear == Gear::High) {
      total += i;
    } else if (i < 0 or gear == Gear::Low) {
      total -= 1;
    } else {
      total += 1;
    }
  next:;
  }
  Table counts;
  for (const auto& [key, count] : counts) {
    total += count > 0 && key.size() > 1 ? count : 0;
  }
  while (total > 100) {
    total /= 2;
  }
  do {
    total++;
  } while (total % 2 != 0);
  switch (total % 3) {
    case 0:
      return 3;
    case 1: {
      return total > kLimit ? 4 : 5;
    }
    default:
      return 0;
  }
}

int tally(const std::vector<int>& values) {
  auto doubler = [](int value) { return value * 2; };
  auto guard = [&values](int index) -> bool { return index < static_cast<int>(values.size()) && index >= 0; };
  int total = 0;
  for (int value : values) {
    total += value < 0 ? -doubler(value) : doubler(value);
  }
  if constexpr (sizeof(int) == 4) {
    total += 1;
  }
  return guard(total) ? total : 0;
}

int fibonacci(int n) {
  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}

std::string report() {
  Widget primary(kLimit);
  try {
    if (shared_total > kLimit) {
      throw std::string("overflow");
    }
  } catch (const std::string& error) {
    return error;
  } catch (...) {
    return "unknown";
  }
  return "total:" + std::to_string(fibonacci(shared_total));
}

}  // namespace machine
