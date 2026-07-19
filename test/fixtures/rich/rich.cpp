#include <map>
#include <string>
#include <vector>
#include "engine/parts.hpp"

namespace machine {

constexpr int kLimit = 10;
inline int shared_total = 0;

enum class Gear { Low, High };

template <typename T>
class Engine {
 public:
  explicit Engine(T base) : base_(base) {}

  T boost(T amount) const {
    return base_ + amount;
  }

 private:
  T base_;
};

class Widget {
 public:
  Widget() : Widget(0) {}
  explicit Widget(int size) : size_(size) {}
  ~Widget() = default;

  int size() const { return size_; }

  bool operator==(const Widget& other) const {
    return size_ == other.size_;
  }

 private:
  int size_;
};

int classify(int value, Gear gear) {
  if (value > kLimit && gear == Gear::High) {
    return 1;
  } else if (value < 0 || gear == Gear::Low) {
    return -1;
  }
  switch (value % 3) {
    case 0:
      return 3;
    case 1:
      return 4;
    default:
      return 0;
  }
}

int tally(const std::vector<int>& values) {
  auto doubler = [](int value) { return value * 2; };
  int total = 0;
  for (int value : values) {
    total += value < 0 ? -doubler(value) : doubler(value);
  }
  std::map<std::string, int> counts;
  for (const auto& [key, count] : counts) {
    total += count > 0 && key.size() > 1 ? count : 0;
  }
  while (total > 100) {
    total /= 2;
  }
  return total;
}

int fibonacci(int n) {
  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}

std::string report() {
  Widget parts[2];
  Widget primary(kLimit);
  Engine<int> engine{2};
  auto copy = Widget{3};
  shared_total += engine.boost(primary.size()) + parts[0].size() + copy.size();
  try {
    if (shared_total > kLimit) {
      throw std::string("overflow");
    }
  } catch (const std::string& error) {
    return error;
  }
  return "total:" + std::to_string(fibonacci(shared_total));
}

}  // namespace machine
