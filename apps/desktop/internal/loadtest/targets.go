package loadtest

import (
	"fmt"
	"net/url"
	"strings"
)

func ValidateRunTargets(plan Plan) error {
	values := map[string]string{}
	for _, variable := range plan.Variables {
		if variable.Value != "" {
			values[variable.Name] = variable.Value
		}
	}
	for _, scenario := range plan.Test.Scenarios {
		for index, step := range scenario.Steps {
			request, exists := plan.Requests[step.RequestID]
			if !exists {
				continue
			}
			target := strings.TrimSpace(applyPathParams(request.URL, request.PathParams))
			for range 8 {
				next := templateName.ReplaceAllStringFunc(target, func(token string) string {
					key := strings.TrimSpace(token[2 : len(token)-2])
					if value, exists := values[key]; exists {
						return value
					}
					return token
				})
				if next == target {
					break
				}
				target = next
			}
			if strings.Contains(target, "{{") {
				if strings.HasPrefix(target, "{{") || strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
					continue
				}
			}
			parsed, err := url.Parse(target)
			if err != nil || parsed.Hostname() == "" || (strings.ToLower(parsed.Scheme) != "http" && strings.ToLower(parsed.Scheme) != "https") {
				return fmt.Errorf("Step %d needs a valid http:// or https:// URL. Open its request and correct the URL before running the load test.", index+1)
			}
		}
	}
	return nil
}
