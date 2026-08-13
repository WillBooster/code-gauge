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
