public class ProbeTryForms {
    void tc() {
        try {
            int y = 1;
        } catch (RuntimeException e) {
            int z = 2;
        }
    }
    void tf() {
        try {
            int y = 1;
        } finally {
            int w = 3;
        }
    }
    void tw() {
        try (java.io.StringReader r = new java.io.StringReader("x")) {
            int y = r.read();
        } catch (java.io.IOException e) {
            int z = 2;
        }
    }
    void sync(Object o) {
        synchronized (o) {
            int y = 1;
        }
    }
    void thr() {
        throw new RuntimeException("x");
    }
    void init() {
        Runnable r = new Runnable() {
            public void run() {
                int y = 1;
            }
        };
        r.run();
    }
}
