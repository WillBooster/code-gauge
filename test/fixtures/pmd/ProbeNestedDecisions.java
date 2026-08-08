public class ProbeNestedDecisions {
    void parens1(boolean a, boolean b, boolean c) {
        if (a && (b && c)) {
            return;
        }
    }
    void parens2(boolean a, boolean b, boolean c) {
        if ((a && b) && c) {
            return;
        }
    }
    void parens3(boolean a, boolean b, boolean c, boolean d) {
        if (a || (b && c) || d) {
            return;
        }
    }
    int initHost() {
        return 1;
    }
    {
        System.out.println("instance init");
    }
    static {
        System.out.println("static init");
    }
    void nested(final int limit) {
        Runnable r = new Runnable() {
            @Override
            public void run() {
                for (int i = 0; i < limit; i++) {
                    if (i % 2 == 0) {
                        System.out.println(i);
                    }
                }
            }
        };
        r.run();
    }
}
