package com.example.rich

import java.util.ArrayList
import kotlin.math.max

/**
 * A warehouse that receives shipments.
 */
interface Store {
    fun receive(shipment: Shipment, stock: Map<String, Int>): Int
}

data class Shipment(val id: String, val quantity: Int) {
    init {
        require(id.isNotEmpty())
    }
}

enum class Status(val label: String) {
    OPEN("open"),
    CLOSED("closed") {
        override fun describe() = "done"
    };

    open fun describe() = label
}

object Registry {
    val names = ArrayList<String>()
}

class Warehouse(seed: List<String>) : Store {
    companion object {
        const val LIMIT = 10
    }

    private val items = ArrayList<String>()
    private var counter = 0

    val size: Int
        get() = items.size

    var name: String = "main"
        private set

    init {
        for (item in seed) {
            items.add(item)
        }
    }

    constructor(seed: List<String>, extra: String) : this(seed) {
        items.add(extra)
    }

    override fun receive(shipment: Shipment, stock: Map<String, Int>): Int {
        counter++
        try {
            if (shipment.quantity > LIMIT && items.isNotEmpty()) {
                items.add(shipment.id)
            } else if (shipment.quantity < 0 || stock.isEmpty()) {
                throw IllegalArgumentException("bad shipment ${shipment.id}")
            } else {
                when (shipment.quantity % 3) {
                    0 -> items.add("zero")
                    1 -> items.add("one")
                    else -> items.remove(shipment.id)
                }
            }
        } catch (error: RuntimeException) {
            return -1
        } finally {
            counter--
        }
        return items.size
    }

    fun describe(value: Any?): String = when (value) {
        is Int -> {
            if (value > LIMIT) "big:$value" else "int:$value"
        }
        is String -> {
            if (value.isBlank()) "blank" else "str:$value"
        }
        null -> "none"
        else -> "other"
    }

    fun drain(): Int {
        var remaining = items.size
        while (remaining > 0) {
            remaining -= 1
            do {
                counter += 1
            } while (counter < 0)
        }
        val hook = object : Runnable {
            override fun run() {
                items.clear()
            }
        }
        hook.run()
        val doubler = { quantity: Int -> quantity * 2 }
        fun local(amount: Int) = amount + counter
        val total = items.map { it.length }.sum()
        val status = if (total > 0) Status.OPEN else Status.CLOSED
        outer@ for (item in items) {
            for (letter in item) {
                if (letter == 'x') break@outer
            }
        }
        val first = items.firstOrNull()?.length ?: 0
        return doubler(remaining) + local(total) + max(first, status.ordinal)
    }
}

fun String.shout(): String = this.uppercase() + "!"

fun fibonacci(n: Int): Int = if (n <= 1) n else fibonacci(n - 1) + fibonacci(n - 2)
