@file:JvmName("Constructs")
package com.example.constructs

import java.util.ArrayList
import kotlin.math.max as maximum

const val LIMIT = 10
var counter = 0

interface Store {
    fun receive(shipment: Shipment, stock: Map<String, Int>): Int
    val size: Int
}

data class Shipment(val id: String, val quantity: Int = 1) {
    init {
        require(id.isNotEmpty())
    }
}

sealed class Result {
    object Empty : Result()
    class Value(val amount: Int) : Result()
}

enum class Status(val label: String) {
    OPEN("open"),
    CLOSED("closed") {
        override fun describe() = "done"
    };

    open fun describe() = label
}

object Registry {
    @JvmStatic
    val names = ArrayList<String>()
}

class Warehouse(seed: List<String>, private val label: String = "main") : Store {
    companion object {
        const val CAPACITY = 100
    }

    private val items = ArrayList<String>()
    override val size: Int
        get() = items.size
    var name: String = label
        private set
    var tag: String = ""
        get() = field.uppercase()
        set(value) {
            field = value.trim()
        }
    lateinit var owner: String

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
        var total = 0
        outer@ for (i in 0 until shipment.quantity) {
            for (key in stock.keys) {
                if (key.length == i) continue@outer
            }
            if (shipment.quantity > LIMIT && items.isNotEmpty()) {
                items.add(shipment.id)
            } else if (shipment.quantity < 0 || stock.isEmpty()) {
                throw IllegalArgumentException("bad shipment ${shipment.id}")
            } else {
                when (shipment.quantity % 3) {
                    0 -> items.add("zero")
                    1, 2 -> items.add("one")
                    else -> items.remove(shipment.id)
                }
            }
            total += i
        }
        do {
            counter--
        } while (counter > 0)
        val outcome = try {
            check(total >= 0) { "negative" }
            total
        } catch (error: IllegalStateException) {
            -1
        } catch (error: RuntimeException) {
            -2
        } finally {
            counter--
        }
        return items.size + outcome
    }

    fun describe(value: Any?): String = when (value) {
        is Int -> {
            if (value > LIMIT) "big:$value" else "int:$value"
        }
        is String -> when {
            value.isBlank() -> "blank"
            else -> "str:$value"
        }
        null -> "none"
        else -> "other"
    }

    fun drain(): Int {
        val hook = object : Runnable {
            override fun run() {
                if (items.isEmpty()) return
                items.clear()
            }
        }
        hook.run()
        val doubler = { quantity: Int -> if (quantity > 0) quantity * 2 else 0 }
        val guard = fun(index: Int): Boolean = index in 0 until items.size && index >= 0
        fun local(amount: Int) = amount + counter
        val total = items.map { it.length }.sumOf { it }
        val first = items.firstOrNull()?.length ?: 0
        return doubler(total) + local(first) + maximum(first, if (guard(first)) 1 else 0)
    }
}

fun String.shout(times: Int = 1): String = this.uppercase() + "!".repeat(times)

fun fibonacci(n: Int): Int = if (n <= 1) n else fibonacci(n - 1) + fibonacci(n - 2)

inline fun <reified T> typeName(): String = T::class.simpleName ?: "unknown"
