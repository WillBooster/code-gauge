require 'json'
require_relative 'helpers'

LIMIT = 10
$counter = 0

module Billing
  RATE = 0.25

  class Invoice
    attr_reader :entries
    @@count = 0

    def initialize(entries = [], *rest, label: 'x', **options, &block)
      @entries = entries
      @@count += 1
      yield self if block_given?
    end

    def self.build(seed) = new(seed)

    def total
      @total ||= @entries.sum
    end

    def classify(value, limit = LIMIT)
      case value
      when Integer, Float then :number
      when String then value.empty? ? :blank : :string
      else :other
      end
      case [value, limit]
      in [Integer => n, _] if n > limit
        :big
      in [String, *tail] unless tail.empty?
        :list
      in [nil, _]
        :none
      in other
        :other
      end
    end

    def process(records)
      records.each_with_index do |record, index|
        next if record.nil?
        if record > LIMIT && index.even?
          add(LIMIT)
        elsif record < 0 || index.odd?
          add(0) unless record.zero?
        else
          add(record)
        end
      end
      total = 0
      until total > LIMIT
        total += 1
        break if total == 5
      end
      while total > 0 do total -= 1 end
      for item in @entries
        next if item.nil?
      end
      begin
        raise ArgumentError, 'bad' if total.negative?
      rescue ArgumentError, TypeError => error
        retry if error.message.empty?
      else
        puts 'ok'
      ensure
        @entries.freeze
      end
      @entries.map { |entry| entry * 2 }.sum
    rescue StandardError => error
      raise "process failed: #{error.message}"
    end

    private

    def add(entry)
      @entries << entry
    end
  end
end

double = ->(value) { value * 2 }
tally = lambda do |values|
  values.each { |value| $counter += value while value.positive? && (value -= 1) }
end

def report(invoice)
  status = invoice.entries.empty? ? 'empty' : 'filled'
  puts "#{status}: #{invoice.total}" if invoice.total
  invoice.classify(invoice.total) rescue :error
end
