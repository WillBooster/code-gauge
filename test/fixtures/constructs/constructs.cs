extern alias Legacy;
using System;
using System.Collections.Generic;
using System.Linq;
using static System.Math;

namespace Example.Constructs;

/// <summary>Store contract.</summary>
public interface IStore
{
    int Receive(Shipment shipment, IDictionary<string, int> stock);
    int Count { get; }
}

public record Shipment(string Id, int Quantity);
public struct Point { public int X; public int Y; }
public enum Status { Open, Closed }
public delegate int Transform(int value);

public class Warehouse : IStore
{
    public const int Limit = 10;
    private readonly List<string> items = new();
    private int counter;
    public event Action<int> Received;
    public event Action Drained
    {
        add { counter++; }
        remove { counter--; }
    }

    public Warehouse(IEnumerable<string> seed) : this()
    {
        foreach (var item in seed)
        {
            items.Add(item);
        }
    }

    public Warehouse() { }

    public int Count
    {
        get { return items.Count; }
        private set { counter = value; }
    }

    public int Auto { get; init; } = 1;
    public bool IsEmpty => items.Count == 0;
    public string this[int index] => items[index];

    public int Receive(Shipment shipment, IDictionary<string, int> stock)
    {
        counter++;
        int total = 0;
        for (int i = 0; i < shipment.Quantity; i++)
        {
            foreach (var extra in stock.Keys)
            {
                if (extra.Length == i) goto next;
            }
            lock (items)
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
                        case 1 when total > 0:
                        case 2:
                            items.Add("one");
                            break;
                        default:
                            items.Remove(shipment.Id);
                            break;
                    }
                }
            }
        next:
            total += i;
        }
        try
        {
            using (var reader = new System.IO.StringReader("x"))
            {
                do
                {
                    counter--;
                } while (counter > 0);
            }
            checked { total += 1; }
        }
        catch (InvalidOperationException error) when (error.Message.Length > 0)
        {
            return -1;
        }
        catch
        {
            return -2;
        }
        finally
        {
            counter--;
        }
        return items.Count + total;
    }

    public string Describe(object value) => value switch
    {
        int number when number > Limit => "big:" + number,
        int number => "int:" + number,
        string text => string.IsNullOrWhiteSpace(text) ? "blank" : "str:" + text,
        null => "none",
        _ => "other",
    };

    public IEnumerable<int> Drain()
    {
        var doubled = from item in items where item.Length > 0 select item.Length * 2;
        Action hook = delegate { items.Clear(); };
        Func<int, int> doubler = quantity => quantity > 0 ? quantity * 2 : 0;
        int Local(int amount) { return amount + counter; }
        foreach (var value in doubled)
        {
            yield return doubler(Local(value));
        }
        yield break;
    }

    public static int Fibonacci(int n) => n <= 1 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);

    public static Warehouse operator +(Warehouse left, Warehouse right) => new(left.items.Concat(right.items));

    public static implicit operator int(Warehouse warehouse) => warehouse.Count;

    ~Warehouse()
    {
        items.Clear();
    }
}
