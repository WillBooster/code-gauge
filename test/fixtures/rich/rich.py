import json
import os.path
from collections import OrderedDict, defaultdict
from . import sibling
from .helpers import alpha as first, beta
from ..shared import common

LIMIT = 10
counter = 0


class Repository:
    """Stores records keyed by kind."""

    def __init__(self):
        self.records = defaultdict(list)

    def add(self, kind, record):
        self.records[kind].append(record)

    async def load(self, path):
        try:
            with open(path) as handle:
                data = json.load(handle)
        except OSError as error:
            raise RuntimeError(f"load failed: {error}")
        for kind, records in data.items():
            if kind == "skip" or not records:
                continue
            elif kind.startswith("_"):
                for record in records:
                    while isinstance(record, list):
                        record = record[0]
                    self.add(kind, record)
            else:
                self.add(kind, records)
        return len(self.records)


def classify(value):
    match value:
        case 0:
            return "zero"
        case int(n) if n > LIMIT:
            return "big"
        case [first_item, *rest]:
            return "list" if rest else str(first_item)
        case _:
            return "other"


def walk(node, depth=0, *branches, limit=LIMIT, **flags):
    total = 1 if (n := depth) >= 0 else 0
    for branch in branches:
        total += walk(branch, depth + 1, limit=limit)
    lam = lambda x: x @ x if flags.get("matrix") else x
    return lam(total) + n


def summarize_orders(orders):
    total = 0
    for order in orders:
        if order["kind"] == "active":
            total += order["amount"] * 2
        else:
            total += order["amount"]
    return total


def summarize_refunds(refunds):
    total = 0
    for refund in refunds:
        if refund["kind"] == "active":
            total += refund["amount"] * 2
        else:
            total += refund["amount"]
    return total
