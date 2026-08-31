using System;
using System.Collections.Generic;
using System.Linq;

namespace Example.Rich;

/// <summary>A warehouse that receives shipments.</summary>
public interface IStore
{
    int Receive(Shipment shipment, IDictionary<string, int> stock);
}

public record Shipment(string Id, int Quantity);

public enum Status
{
    Open,
    Closed,
}

public class Warehouse : IStore
{
    public const int Limit = 10;
    private readonly List<string> items = new();
    private int counter;

    public Warehouse(IEnumerable<string> seed)
    {
        foreach (var item in seed)
        {
            items.Add(item);
        }
    }

    public int Count
    {
        get { return items.Count; }
        private set { counter = value; }
    }

    public bool IsEmpty => items.Count == 0;

    public string this[int index] => items[index];

    public int Receive(Shipment shipment, IDictionary<string, int> stock)
    {
        counter++;
        try
        {
            if (shipment.Quantity > Limit && items.Count > 0)
            {
                items.Add(shipment.Id);
            }
            else if (shipment.Quantity < 0 || stock.Count == 0)
            {
                throw new ArgumentException($"bad shipment {shipment.Id}");
            }
            else
            {
                switch (shipment.Quantity % 3)
                {
                    case 0:
                        items.Add("zero");
                        break;
                    case 1:
                        items.Add("one");
                        break;
                    default:
                        items.Remove(shipment.Id);
                        break;
                }
            }
        }
        catch (InvalidOperationException error) when (error.Message.Length > 0)
        {
            return -1;
        }
        finally
        {
            counter--;
        }
        return items.Count;
    }

    public string Describe(object value) => value switch
    {
        int number when number > Limit => "big:" + number,
        int number => "int:" + number,
        string text => string.IsNullOrWhiteSpace(text) ? "blank" : "str:" + text,
        _ => "other",
    };

    public int Drain()
    {
        int remaining = items.Count;
        while (remaining > 0)
        {
            remaining -= 1;
            do
            {
                counter += 1;
            } while (counter < 0);
        }
        Action hook = delegate
        {
            items.Clear();
        };
        hook();
        Func<int, int> doubler = quantity => quantity * 2;
        int Local(int amount)
        {
            return amount + counter;
        }
        var total = items.Select(item => item.Length).Sum();
        Status status = total > 0 ? Status.Open : Status.Closed;
        goto done;
    done:
        return doubler.Apply(remaining) + Local(total) + (int)status;
    }

    public static int Fibonacci(int n)
    {
        return n <= 1 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);
    }

    public static Warehouse operator +(Warehouse left, Warehouse right)
    {
        return new Warehouse(left.items.Concat(right.items));
    }

    ~Warehouse()
    {
        items.Clear();
    }
}
