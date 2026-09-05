package constructs

import (
	"errors"
	"fmt"
)

const Limit = 10

var (
	counter int
	names   = []string{"a"}
)

type Store struct {
	items map[string]int
	label string
}

type Reader interface {
	Read(key string) (int, error)
	fmt.Stringer
}

type Alias = Store

func NewStore(seed ...string) *Store {
	s := &Store{items: map[string]int{}}
	for i, name := range seed {
		s.items[name] = i
	}
	return s
}

func (s *Store) Read(key string) (int, error) {
	if value, ok := s.items[key]; ok {
		return value, nil
	}
	return 0, errors.New("missing " + key)
}

func (s Store) String() string { return s.label }

func Classify(value interface{}, limit int) string {
	total := 0
outer:
	for i := 0; i < limit; i++ {
		for j := range names {
			if i == j {
				continue outer
			}
		}
		switch v := value.(type) {
		case int:
			if v > limit && v%2 == 0 {
				total += v
			} else if v < 0 || v == limit {
				total--
			} else {
				total++
			}
		case string, error:
			total = len(fmt.Sprint(v))
		default:
			total = 1
		}
		switch total % 3 {
		case 0:
			fallthrough
		case 1:
			goto done
		}
	}
done:
	ch := make(chan int, 1)
	go func() { ch <- total }()
	defer close(ch)
	select {
	case got := <-ch:
		return fmt.Sprint(got)
	default:
		return "none"
	}
}

func Countdown(n int) int {
	if n <= 0 {
		return 0
	}
	return Countdown(n - 1)
}

var scale = func(a, b int) int { return a * b }
