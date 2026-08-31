public class Parity
{
    public string classify(int[] items, int limit)
    {
        int total = 0;
        foreach (int item in items)
        {
            if (item > limit && item % 2 == 0)
            {
                total += item;
            }
            else if (item < 0)
            {
                total -= 1;
            }
            else
            {
                total += 1;
            }
        }
        switch (total % 3)
        {
            case 0:
                return "zero";
            case 1:
                return "one";
            default:
                return "other";
        }
    }
}
