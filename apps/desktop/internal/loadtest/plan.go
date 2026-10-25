package loadtest

import "github.com/stormhop/kurlo/apps/desktop/internal/model"

type Pair struct {
	Key   string
	Value string
}

type FormField struct {
	Key    string
	Value  string
	IsFile bool
}

type Request struct {
	ID         string
	Name       string
	Type       string
	Method     string
	URL        string
	PathParams []Pair
	Query      []Pair
	Headers    []Pair
	BodyType   string
	Body       string
	Form       []FormField
	Auth       model.AuthConfig
	TimeoutMs  int
	VerifyTLS  bool
	HasScripts bool
}

type Variable struct {
	Name   string
	Value  string
	Secret bool
}

type Plan struct {
	Test       model.LoadTest
	Collection string
	Requests   map[string]Request
	Variables  []Variable
	Data       []map[string]string
	DataError  string
}

type Options struct {
	InlineSecrets bool
}
