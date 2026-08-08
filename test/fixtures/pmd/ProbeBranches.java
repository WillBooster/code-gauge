public class ProbeBranches {
    void sw(int x) {
        switch (x) {
            case 1:
                x++;
                break;
            case 2:
                x--;
                break;
            default:
                x = 0;
                break;
        }
    }
    void tern(int x) {
        int y = x > 0 ? 1 : 2;
        int z = x > 1 ? (x > 2 ? 3 : 4) : 5;
    }
    void bools(boolean a, boolean b, boolean c, boolean d) {
        if (a && b && c || d) {
            return;
        }
        while (a || b || (c && d)) {
            a = false;
        }
    }
    void nest(int x) {
        for (int i = 0; i < x; i++) {
            while (x > 0) {
                if (x == 2) {
                    x--;
                }
            }
        }
    }
    void lam(java.util.List<Integer> xs) {
        xs.forEach(v -> {
            if (v > 0) {
                System.out.println(v);
            }
        });
    }
}
