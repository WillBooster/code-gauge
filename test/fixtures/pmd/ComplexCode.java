import java.awt.*;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.image.BufferedImage;
import java.util.ArrayDeque;
import java.util.Deque;
import javax.swing.*;

public class MainWindow extends JFrame {

    public static void main(String[] args) {
        new MainWindow();
    }

    public MainWindow() {
        super("Paint Tool");
        this.setContentPane(this.createContentPane());
        this.getContentPane().setBackground(Color.GRAY);
        this.setBackground(Color.GRAY);
        this.setSize(600, 400);
        this.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        this.setVisible(true);
    }

    private JPanel createContentPane() {
        JPanel contentPane = new JPanel(new BorderLayout());

        MyPanel myPanel = new MyPanel();
        MouseListener listener = new MouseListener(myPanel);
        myPanel.addMouseListener(listener);
        myPanel.addMouseMotionListener(listener);
        contentPane.add(myPanel, BorderLayout.CENTER);

        // Create radio buttons panel
        JPanel radioPanel = new JPanel();
        radioPanel.setBackground(Color.GRAY);

        ButtonGroup buttonGroup = new ButtonGroup();
        JRadioButton penButton = new JRadioButton("Pen", true);
        JRadioButton fillButton = new JRadioButton("Fill", false);

        penButton.setActionCommand("Pen");
        fillButton.setActionCommand("Fill");

        buttonGroup.add(penButton);
        buttonGroup.add(fillButton);

        radioPanel.add(penButton);
        radioPanel.add(fillButton);

        contentPane.add(radioPanel, BorderLayout.EAST);

        // Set the radio buttons in the listener
        listener.setPenButton(penButton);
        listener.setFillButton(fillButton);

        return contentPane;
    }
}

class MouseListener extends MouseAdapter {

    private final MyPanel myPanel;
    private int lastX;
    private int lastY;
    private JRadioButton penButton;
    private JRadioButton fillButton;

    MouseListener(MyPanel myPanel) {
        this.myPanel = myPanel;
    }

    public void setPenButton(JRadioButton penButton) {
        this.penButton = penButton;
    }

    public void setFillButton(JRadioButton fillButton) {
        this.fillButton = fillButton;
    }

    @Override
    public void mousePressed(MouseEvent e) {
        lastX = e.getX();
        lastY = e.getY();

        if (penButton.isSelected()) {
            myPanel.drawLine(lastX, lastY, lastX, lastY);
        } else if (fillButton.isSelected()) {
            myPanel.fill(lastX, lastY);
        }
    }

    @Override
    public void mouseDragged(MouseEvent e) {
        if (penButton.isSelected()) {
            int currentX = e.getX();
            int currentY = e.getY();
            myPanel.drawLine(lastX, lastY, currentX, currentY);
            lastX = currentX;
            lastY = currentY;
        }
    }
}

class MyPanel extends JPanel {

    private static int[][] deltas = {
        { -1, 0 },
        { 1, 0 },
        { 0, -1 },
        { 0, 1 },
    };

    private final BufferedImage image;

    public MyPanel() {
        this.setName("canvas");
        this.setBackground(Color.GRAY);
        this.image = new BufferedImage(320, 240, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = this.image.createGraphics();
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, this.image.getWidth(), this.image.getHeight());
        g.dispose();
    }

    public void drawLine(int startX, int startY, int endX, int endY) {
        Graphics2D g = this.image.createGraphics();
        g.setColor(Color.BLACK);
        g.drawLine(startX, startY, endX, endY);
        this.repaint();
    }

    public void fill(int x, int y) {
        // Check if the point is within the image bounds
        if (x < 0 || x >= image.getWidth() || y < 0 || y >= image.getHeight()) {
            return;
        }

        // Get the target color (the color we're trying to fill)
        int targetColor = image.getRGB(x, y);

        // If the target is already black, return
        if (targetColor == Color.BLACK.getRGB()) {
            return;
        }

        // Use a Deque as a stack for iterative flood fill
        Deque<Point> stack = new ArrayDeque<>();
        stack.push(new Point(x, y));

        while (!stack.isEmpty()) {
            Point p = stack.pop();

            // Skip if out of bounds or already processed
            if (
                p.x < 0 ||
                p.x >= image.getWidth() ||
                p.y < 0 ||
                p.y >= image.getHeight()
            ) {
                continue;
            }

            // Skip if this pixel isn't the target color
            if (image.getRGB(p.x, p.y) != targetColor) {
                continue;
            }

            // Fill this pixel
            image.setRGB(p.x, p.y, Color.BLACK.getRGB());

            // Add adjacent pixels to stack
            for (int[] delta : deltas) {
                stack.push(new Point(p.x + delta[0], p.y + delta[1]));
            }
        }

        this.repaint();
    }

    @Override
    public void paint(Graphics g) {
        g.drawImage(this.image, 0, 0, this);
    }
}
