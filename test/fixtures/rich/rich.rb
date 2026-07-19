require 'json'
require_relative 'helpers'
require_relative './formatter'
autoload :Ledger, './ledger'

LIMIT = 10
MIN, MAX = 1, 100

module Billing
  RATE = 0.25

  class Invoice
    attr_reader :entries

    def initialize
      @entries = []
      @@count ||= 0
    end

    def add(entry)
      @entries << entry
      self.total ||= 0
      self.total += entry
    end

    def total
      @total
    end

    def total=(value)
      @total = value
    end

    def classify(value)
      case value
      in Integer => n if n > LIMIT
        :big
      in [head, *tail]
        tail.empty? ? head : :list
      in nil
        :none
      else
        :other
      end
    end

    def process(records)
      records.each do |record|
        next if record.nil?
        if record > MAX
          add(MAX)
        elsif record < MIN
          add(MIN) unless record.zero?
        else
          add(record)
        end
      end
      yield @entries if block_given?
      @entries.map { |entry| entry * 2 }.sum
    rescue StandardError => error
      raise "process failed: #{error.message}"
    ensure
      @entries.freeze
    end
  end
end

double = ->(value) { value * 2 }
tally = lambda do |values|
  total = 0
  values.each { |value| total += value while value.positive? && (value -= 1) }
  total
end

def report(invoice)
  status = invoice.entries.empty? ? 'empty' : 'filled'
  puts "#{status}: #{invoice.total}" if invoice.total
  invoice.classify(invoice.total) rescue :error
end
