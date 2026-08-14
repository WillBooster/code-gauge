class Alpha {
  void act() {}

  void act(int amount) {}

  void run() {
    act(1);
    this.act();
  }
}

class Beta {
  void act() {}

  void go() {
    act();
  }
}
