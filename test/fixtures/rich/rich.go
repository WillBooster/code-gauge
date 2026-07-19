package rich

import (
	"errors"
	"fmt"
	str "strings"
)

const Limit = 10

var counter int

type Store struct {
	items map[string]int
}

type Reader interface {
	Read(key string) (int, error)
}

func NewStore() *Store {
	return &Store{items: map[string]int{}}
}

func (s *Store) Read(key string) (int, error) {
	value, ok := s.items[key]
	if !ok {
		return 0, errors.New("missing " + key)
	}
	return value, nil
}

func (s *Store) Fill(pairs []string) int {
	total := 0
	for index, pair := range pairs {
		parts := str.Split(pair, "=")
		switch len(parts) {
		case 2:
			s.items[parts[0]] = index
			total++
		case 1:
			s.items[parts[0]] = 0
		default:
			continue
		}
	}
	return total
}

func Classify(value interface{}) string {
	switch v := value.(type) {
	case int:
		if v > Limit && v%2 == 0 {
			return "big-even"
		}
		return fmt.Sprintf("int:%d", v)
	case string:
		return "str:" + v
	default:
		return "unknown"
	}
}

func Consume(ch chan int, done chan bool) int {
	total := 0
	for {
		select {
		case value := <-ch:
			total += value
		case <-done:
			return total
		}
	}
}

func Fibonacci(n int) int {
	if n <= 1 {
		return n
	}
	return Fibonacci(n-1) + Fibonacci(n-2)
}

var scale = func(value int) int { return value * 2 }

func Report(store *Store) string {
	counter++
	value, err := store.Read("main")
	if err != nil {
		value = scale(Limit)
	}
	return fmt.Sprintf("report:%d:%d", value, counter)
}
