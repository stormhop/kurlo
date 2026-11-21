package loadtest

import (
	"crypto/sha256"
	"fmt"
	"slices"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/util"
)

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
	Redirects  *int
	Variables  []Variable
}

type Variable struct {
	Name   string
	Value  string
	Secret bool
	Linked bool
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
	SeparateData  bool
	InlineSecrets bool
}

func (r Request) secretKey(index int) string {
	key := sha256.Sum256([]byte(r.ID))
	return fmt.Sprintf("KURLO_REQUEST_%X_%d", key[:8], index+1)
}

func (p Plan) RuntimeVariables() []Variable {
	vars := slices.Clone(p.Variables)
	if len(p.Test.Scenarios) == 0 {
		return vars
	}
	seen := map[string]bool{}
	for _, step := range p.Test.Scenarios[0].Steps {
		if seen[step.RequestID] {
			continue
		}
		seen[step.RequestID] = true
		request := p.Requests[step.RequestID]
		for index, v := range request.Variables {
			if v.Secret {
				vars = append(vars, Variable{Name: request.secretKey(index), Value: v.Value, Secret: true})
			}
		}
	}
	return vars
}

func (p Plan) RequestTarget(r Request) string {
	values := map[string]string{}
	for _, v := range p.Variables {
		values[v.Name] = v.Value
	}
	resolve := func(text string) string {
		for range 10 {
			next := templateName.ReplaceAllStringFunc(text, func(token string) string {
				if v, ok := values[strings.TrimSpace(token[2:len(token)-2])]; ok {
					return v
				}
				return token
			})
			if text == next {
				break
			}
			text = next
		}
		return text
	}
	for _, v := range r.Variables {
		values[v.Name] = resolve(v.Value)
	}
	parts := pathParts(r.URL, r.PathParams, resolve, func(value string) string {
		return util.EscapePathParamValue(resolve(value))
	})
	return strings.Join(parts, "")
}
