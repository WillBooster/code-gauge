public class ProbeSignatures {
    interface Shape {
        int area();
        default int twice() {
            return area() * 2;
        }
    }
    abstract static class Base {
        abstract void render(int depth);
        void done() {
            System.out.println("done");
        }
    }
    void thr() {
        throw new RuntimeException("x");
    }
    void twoThrows(boolean b) {
        if (b) {
            throw new IllegalStateException("a");
        }
        throw new RuntimeException("b");
    }
    void existingResource(java.io.Reader r) throws java.io.IOException {
        try (r) {
            r.read();
        }
    }
}
