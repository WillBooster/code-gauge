public class ProbeStatements {
    void a(int x) {
        if (x > 0) {
            x++;
        } else if (x < -5) {
            x--;
        } else {
            x = 0;
        }
    }
    void b(int x) {
        switch (x) {
            case 1:
                x++;
                break;
            default:
                x--;
                break;
        }
    }
    void c() {
        try {
            int y = 1;
        } catch (RuntimeException e) {
            int z = 2;
        } finally {
            int w = 3;
        }
    }
    void d(int x) {
        for (int i = 0; i < x; i++) {
            outer:
            while (x > 1) {
                do { x--; } while (x > 0);
                break outer;
            }
        }
        assert x >= 0;
        ;
    }
    int e(int x) {
        int a = 1, b = 2;
        return a + b + x;
    }
    int f(int x) {
        java.util.function.IntUnaryOperator g = y -> { int q = y + 1; return q; };
        return g.applyAsInt(x);
    }
}
