package visibility

const Limit, floor = 8, 1

var Counter int

type Widget struct{}

type helper struct{}

func (w Widget) Describe() string {
	return "widget"
}

func (h helper) describe() string {
	return "helper"
}

func Shared() int {
	return Limit + floor
}

func internal() int {
	return Shared()
}

var (
	Grouped = 2
	grouped = 3
)

type Alias = string

type hiddenAlias = string
