package script

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/d5/tengo/v2"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const scriptMaxAllocs int64 = 250000

func runTengo(src string, ctx *Context, hasResponse bool) string {
	if containsTengoImport(src) {
		return "imports are disabled in scripts"
	}

	s := tengo.NewScript([]byte(src))
	s.SetImports(tengo.NewModuleMap())
	s.SetMaxAllocs(scriptMaxAllocs)

	if err := s.Add("pm", buildPM(ctx, hasResponse)); err != nil {
		return "setup error: " + err.Error()
	}

	runCtx, cancel := context.WithTimeout(context.Background(), scriptExecutionTimeout)
	defer cancel()

	if _, err := s.RunContext(runCtx); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "script timed out after " + scriptExecutionTimeout.String()
		}
		return err.Error()
	}
	return ""
}

func containsTengoImport(src string) bool {
	inLineComment := false
	inBlockComment := false
	inString := byte(0)
	escaped := false

	for i := 0; i < len(src); i++ {
		ch := src[i]
		next := byte(0)
		if i+1 < len(src) {
			next = src[i+1]
		}

		if inLineComment {
			if ch == '\n' || ch == '\r' {
				inLineComment = false
			}
			continue
		}
		if inBlockComment {
			if ch == '*' && next == '/' {
				inBlockComment = false
				i++
			}
			continue
		}
		if inString != 0 {
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' && inString != '`' {
				escaped = true
				continue
			}
			if ch == inString {
				inString = 0
			}
			continue
		}

		if ch == '/' && next == '/' {
			inLineComment = true
			i++
			continue
		}
		if ch == '/' && next == '*' {
			inBlockComment = true
			i++
			continue
		}
		if ch == '"' || ch == '\'' || ch == '`' {
			inString = ch
			continue
		}
		if !strings.HasPrefix(src[i:], "import") {
			continue
		}
		if i > 0 {
			prevRune, _ := utf8.DecodeLastRuneInString(src[:i])
			if isTengoIdentifierRune(prevRune) {
				continue
			}
		}
		j := i + len("import")
		if j < len(src) {
			nextRune, _ := utf8.DecodeRuneInString(src[j:])
			if isTengoIdentifierRune(nextRune) {
				continue
			}
		}
		for j < len(src) && unicode.IsSpace(rune(src[j])) {
			j++
		}
		if j < len(src) && src[j] == '(' {
			return true
		}
	}
	return false
}

func isTengoIdentifierRune(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r)
}

func buildPM(ctx *Context, hasResponse bool) *tengo.Map {
	m := map[string]tengo.Object{
		"variables":   buildKVStore(ctx.Variables),
		"environment": buildKVStore(ctx.Environment),
		"request":     buildRequest(ctx),
		"test":        buildTest(ctx),
		"expect":      buildExpect(),
		"log":         buildLog(ctx),
	}
	if hasResponse && ctx.Response != nil {
		m["response"] = buildResponse(ctx.Response)
	}
	return &tengo.Map{Value: m}
}

func buildKVStore(store map[string]string) *tengo.Map {
	return &tengo.Map{Value: map[string]tengo.Object{
		"get": &tengo.UserFunction{
			Name: "get",
			Value: func(args ...tengo.Object) (tengo.Object, error) {
				if len(args) < 1 {
					return tengo.UndefinedValue, nil
				}
				if v, ok := store[tengoString(args[0])]; ok {
					return &tengo.String{Value: v}, nil
				}
				return tengo.UndefinedValue, nil
			},
		},
		"set": &tengo.UserFunction{
			Name: "set",
			Value: func(args ...tengo.Object) (tengo.Object, error) {
				if len(args) >= 2 {
					store[tengoString(args[0])] = tengoString(args[1])
				}
				return tengo.UndefinedValue, nil
			},
		},
		"unset": &tengo.UserFunction{
			Name: "unset",
			Value: func(args ...tengo.Object) (tengo.Object, error) {
				if len(args) >= 1 {
					delete(store, tengoString(args[0]))
				}
				return tengo.UndefinedValue, nil
			},
		},
		"clear": &tengo.UserFunction{
			Name: "clear",
			Value: func(args ...tengo.Object) (tengo.Object, error) {
				for k := range store {
					delete(store, k)
				}
				return tengo.UndefinedValue, nil
			},
		},
	}}
}

func buildRequest(ctx *Context) *tengo.Map {
	return &tengo.Map{Value: map[string]tengo.Object{
		"url":    &tengo.String{Value: ctx.RequestURL},
		"method": &tengo.String{Value: ctx.RequestMethod},

		"set_url": &tengo.UserFunction{
			Name: "set_url",
			Value: func(args ...tengo.Object) (tengo.Object, error) {
				if len(args) >= 1 {
					ctx.RequestURL = tengoString(args[0])
				}
				return tengo.UndefinedValue, nil
			},
		},

		"body":      &tengo.String{Value: ctx.RequestBody},
		"body_type": &tengo.String{Value: ctx.RequestBodyType},
		"set_body": &tengo.UserFunction{
			Name: "set_body",
			Value: func(args ...tengo.Object) (tengo.Object, error) {
				if len(args) >= 1 {
					ctx.RequestBody = tengoString(args[0])
					ctx.RequestBodyChanged = true
				}
				return tengo.UndefinedValue, nil
			},
		},

		"headers": &tengo.Map{Value: map[string]tengo.Object{
			"get": &tengo.UserFunction{
				Name: "get",
				Value: func(args ...tengo.Object) (tengo.Object, error) {
					if len(args) < 1 {
						return tengo.UndefinedValue, nil
					}
					key := tengoString(args[0])
					for k, v := range ctx.RequestHeaders {
						if strings.EqualFold(k, key) {
							return &tengo.String{Value: v}, nil
						}
					}
					return tengo.UndefinedValue, nil
				},
			},
			"set": &tengo.UserFunction{
				Name: "set",
				Value: func(args ...tengo.Object) (tengo.Object, error) {
					if len(args) >= 2 {
						ctx.SetRequestHeader(tengoString(args[0]), tengoString(args[1]))
					}
					return tengo.UndefinedValue, nil
				},
			},
			"unset": &tengo.UserFunction{
				Name: "unset",
				Value: func(args ...tengo.Object) (tengo.Object, error) {
					if len(args) >= 1 {
						ctx.UnsetRequestHeader(tengoString(args[0]))
					}
					return tengo.UndefinedValue, nil
				},
			},
		}},

		"pathVariables": &tengo.Map{Value: map[string]tengo.Object{
			"get": &tengo.UserFunction{
				Name: "get",
				Value: func(args ...tengo.Object) (tengo.Object, error) {
					if len(args) < 1 {
						return tengo.UndefinedValue, nil
					}
					if v, ok := ctx.RequestPathParams[tengoString(args[0])]; ok {
						return &tengo.String{Value: v}, nil
					}
					return tengo.UndefinedValue, nil
				},
			},
			"set": &tengo.UserFunction{
				Name: "set",
				Value: func(args ...tengo.Object) (tengo.Object, error) {
					if len(args) >= 2 {
						ctx.SetRequestPathParam(tengoString(args[0]), tengoString(args[1]))
					}
					return tengo.UndefinedValue, nil
				},
			},
		}},

		"params": &tengo.Map{Value: map[string]tengo.Object{
			"get": &tengo.UserFunction{
				Name: "get",
				Value: func(args ...tengo.Object) (tengo.Object, error) {
					if len(args) < 1 {
						return tengo.UndefinedValue, nil
					}
					if v, ok := ctx.RequestParams[tengoString(args[0])]; ok {
						return &tengo.String{Value: v}, nil
					}
					return tengo.UndefinedValue, nil
				},
			},
			"set": &tengo.UserFunction{
				Name: "set",
				Value: func(args ...tengo.Object) (tengo.Object, error) {
					if len(args) >= 2 {
						ctx.SetRequestParam(tengoString(args[0]), tengoString(args[1]))
					}
					return tengo.UndefinedValue, nil
				},
			},
			"unset": &tengo.UserFunction{
				Name: "unset",
				Value: func(args ...tengo.Object) (tengo.Object, error) {
					if len(args) >= 1 {
						ctx.UnsetRequestParam(tengoString(args[0]))
					}
					return tengo.UndefinedValue, nil
				},
			},
		}},
	}}
}

func buildResponse(resp *model.HttpResponse) *tengo.Map {
	return &tengo.Map{Value: map[string]tengo.Object{
		"code":   &tengo.Int{Value: int64(resp.StatusCode)},
		"status": &tengo.String{Value: resp.Status},
		"time":   &tengo.Int{Value: resp.Duration},
		"size":   &tengo.Int{Value: resp.Size},

		"body": &tengo.UserFunction{
			Name: "body",
			Value: func(args ...tengo.Object) (tengo.Object, error) {
				return &tengo.String{Value: resp.Body}, nil
			},
		},

		"json": &tengo.UserFunction{
			Name: "json",
			Value: func(args ...tengo.Object) (tengo.Object, error) {
				var parsed interface{}
				if err := json.Unmarshal([]byte(resp.Body), &parsed); err != nil {
					return tengo.UndefinedValue, fmt.Errorf("response body is not valid JSON: %w", err)
				}
				return goToTengo(parsed), nil
			},
		},

		"llm": &tengo.UserFunction{
			Name: "llm",
			Value: func(args ...tengo.Object) (tengo.Object, error) {
				if resp.Llm == "" {
					return tengo.UndefinedValue, fmt.Errorf("response.llm() is only available on AI requests")
				}
				var parsed interface{}
				if err := json.Unmarshal([]byte(resp.Llm), &parsed); err != nil {
					return tengo.UndefinedValue, err
				}
				return goToTengo(parsed), nil
			},
		},

		"headers": &tengo.Map{Value: map[string]tengo.Object{
			"get": &tengo.UserFunction{
				Name: "get",
				Value: func(args ...tengo.Object) (tengo.Object, error) {
					if len(args) < 1 {
						return tengo.UndefinedValue, nil
					}
					key := strings.ToLower(tengoString(args[0]))
					for _, h := range resp.Headers {
						if strings.ToLower(h.Key) == key {
							return &tengo.String{Value: h.Value}, nil
						}
					}
					return tengo.UndefinedValue, nil
				},
			},
		}},
	}}
}

func buildTest(ctx *Context) *tengo.UserFunction {
	return &tengo.UserFunction{
		Name: "test",
		Value: func(args ...tengo.Object) (tengo.Object, error) {
			if len(args) < 2 {
				return tengo.UndefinedValue, nil
			}
			name := tengoString(args[0])
			passed, errMsg := isTruthy(args[1])
			ctx.Tests = append(ctx.Tests, model.TestResult{
				Name:   name,
				Passed: passed,
				Error:  errMsg,
			})
			return tengo.UndefinedValue, nil
		},
	}
}

func buildExpect() *tengo.UserFunction {
	return &tengo.UserFunction{
		Name: "expect",
		Value: func(args ...tengo.Object) (tengo.Object, error) {
			var subject tengo.Object = tengo.UndefinedValue
			if len(args) >= 1 {
				subject = args[0]
			}

			boolObj := func(b bool) tengo.Object {
				if b {
					return tengo.TrueValue
				}
				return tengo.FalseValue
			}

			subjectStr := tengoString(subject)
			subjectInt, subjectIsNum := tengoInt(subject)

			return &tengo.Map{Value: map[string]tengo.Object{
				"exists": &tengo.UserFunction{
					Name: "exists",
					Value: func(args ...tengo.Object) (tengo.Object, error) {
						_, isUndef := subject.(*tengo.Undefined)
						return boolObj(!isUndef && subject != nil), nil
					},
				},
				"is_null": &tengo.UserFunction{
					Name: "is_null",
					Value: func(args ...tengo.Object) (tengo.Object, error) {
						_, isUndef := subject.(*tengo.Undefined)
						return boolObj(isUndef || subject == nil), nil
					},
				},
				"equal": &tengo.UserFunction{
					Name: "equal",
					Value: func(args ...tengo.Object) (tengo.Object, error) {
						if len(args) < 1 {
							return tengo.FalseValue, nil
						}
						return boolObj(subject.String() == args[0].String()), nil
					},
				},
				"not_equal": &tengo.UserFunction{
					Name: "not_equal",
					Value: func(args ...tengo.Object) (tengo.Object, error) {
						if len(args) < 1 {
							return tengo.TrueValue, nil
						}
						return boolObj(subject.String() != args[0].String()), nil
					},
				},
				"contains": &tengo.UserFunction{
					Name: "contains",
					Value: func(args ...tengo.Object) (tengo.Object, error) {
						if len(args) < 1 {
							return tengo.FalseValue, nil
						}
						return boolObj(strings.Contains(subjectStr, tengoString(args[0]))), nil
					},
				},
				"has_key": &tengo.UserFunction{
					Name: "has_key",
					Value: func(args ...tengo.Object) (tengo.Object, error) {
						if len(args) < 1 {
							return tengo.FalseValue, nil
						}
						m, ok := subject.(*tengo.Map)
						if !ok {
							return tengo.FalseValue, nil
						}
						_, found := m.Value[tengoString(args[0])]
						return boolObj(found), nil
					},
				},
				"greater_than": &tengo.UserFunction{
					Name: "greater_than",
					Value: func(args ...tengo.Object) (tengo.Object, error) {
						if !subjectIsNum || len(args) < 1 {
							return tengo.FalseValue, nil
						}
						cmp, ok := tengoInt(args[0])
						if !ok {
							return tengo.FalseValue, nil
						}
						return boolObj(subjectInt > cmp), nil
					},
				},
				"less_than": &tengo.UserFunction{
					Name: "less_than",
					Value: func(args ...tengo.Object) (tengo.Object, error) {
						if !subjectIsNum || len(args) < 1 {
							return tengo.FalseValue, nil
						}
						cmp, ok := tengoInt(args[0])
						if !ok {
							return tengo.FalseValue, nil
						}
						return boolObj(subjectInt < cmp), nil
					},
				},
				"type_of": &tengo.UserFunction{
					Name: "type_of",
					Value: func(args ...tengo.Object) (tengo.Object, error) {
						return &tengo.String{Value: subject.TypeName()}, nil
					},
				},
			}}, nil
		},
	}
}

func buildLog(ctx *Context) *tengo.UserFunction {
	return &tengo.UserFunction{
		Name: "log",
		Value: func(args ...tengo.Object) (tengo.Object, error) {
			parts := make([]string, len(args))
			for i, a := range args {
				parts[i] = tengoString(a)
			}
			ctx.Logs = append(ctx.Logs, strings.Join(parts, " "))
			return tengo.UndefinedValue, nil
		},
	}
}

func tengoString(o tengo.Object) string {
	switch v := o.(type) {
	case *tengo.String:
		return v.Value
	case *tengo.Int:
		return fmt.Sprintf("%d", v.Value)
	case *tengo.Float:
		return fmt.Sprintf("%g", v.Value)
	case *tengo.Bool:
		if !v.IsFalsy() {
			return "true"
		}
		return "false"
	case *tengo.Undefined:
		return ""
	default:
		return o.String()
	}
}

func tengoInt(o tengo.Object) (int64, bool) {
	switch v := o.(type) {
	case *tengo.Int:
		return v.Value, true
	case *tengo.Float:
		return int64(v.Value), true
	default:
		return 0, false
	}
}

func isTruthy(o tengo.Object) (passed bool, errMsg string) {
	switch v := o.(type) {
	case *tengo.Bool:
		return !v.IsFalsy(), ""
	case *tengo.Undefined:
		return false, "value is undefined"
	case *tengo.Int:
		return v.Value != 0, ""
	case *tengo.String:
		return v.Value != "", ""
	default:
		return o != nil, ""
	}
}

func goToTengo(v interface{}) tengo.Object {
	switch val := v.(type) {
	case map[string]interface{}:
		m := make(map[string]tengo.Object, len(val))
		for k, v2 := range val {
			m[k] = goToTengo(v2)
		}
		return &tengo.Map{Value: m}
	case []interface{}:
		arr := make([]tengo.Object, len(val))
		for i, v2 := range val {
			arr[i] = goToTengo(v2)
		}
		return &tengo.Array{Value: arr}
	case string:
		return &tengo.String{Value: val}
	case float64:
		if val == float64(int64(val)) {
			return &tengo.Int{Value: int64(val)}
		}
		return &tengo.Float{Value: val}
	case bool:
		if val {
			return tengo.TrueValue
		}
		return tengo.FalseValue
	default:
		return tengo.UndefinedValue
	}
}
