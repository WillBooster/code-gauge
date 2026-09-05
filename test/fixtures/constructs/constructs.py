import os
from typing import Optional
from . import sibling

LIMIT = 10
counter: int = 0


class Registry:
    """Docstring."""

    items: list[int] = []

    def __init__(self, seed: Optional[int] = None) -> None:
        self.seed = seed

    @property
    def size(self) -> int:
        return len(self.items)

    @staticmethod
    def build(*values, **options):
        return Registry(values[0] if values else options.get("seed"))

    async def load(self, path):
        async with open(path) as handle:
            async for line in handle:
                yield line


def classify(items, limit=LIMIT, /, *, strict=False):
    global counter
    total = 0
    for item in items:
        if item > limit and item % 2 == 0:
            total += item
        elif item < 0 or item == limit:
            total -= 1
        else:
            total += 1
    else:
        counter += 1
    while total > limit:
        total -= 1
        if strict:
            break
    else:
        pass
    try:
        assert total >= 0, "negative"
        match total % 3:
            case 0:
                return "zero"
            case 1 if strict:
                return "one"
            case [first, *rest]:
                return "list"
            case _:
                raise ValueError("other")
    except (ValueError, TypeError) as error:
        return str(error)
    except Exception:
        raise
    finally:
        del total
    with open("a") as a, open("b") as b:
        pass
    return "unreachable" if strict else None


def outer(values):
    def inner(value):
        nonlocal values
        return value if value in values else -value

    squares = [inner(v) for v in values]
    scale = lambda x: x * 2 if x else 0
    return sum(squares) + scale(len(values))


def countdown(n):
    if n <= 0:
        return 0
    return countdown(n - 1)
