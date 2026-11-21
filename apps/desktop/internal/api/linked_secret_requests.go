package api

import (
	"context"
	"errors"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
)

var linkedSecretVariableMaps = map[string]bool{
	"TemplateValues":      true,
	"ScriptEnvironment":   true,
	"ScriptVariables":     true,
	"CollectionVariables": true,
	"RequestVariables":    true,
	"IterationData":       true,
}

type linkedStringSlot struct {
	value   string
	set     func(string)
	mapName string
	key     string
}

func collectLinkedStringSlots(v reflect.Value, fieldName string, out *[]linkedStringSlot) {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			collectLinkedStringSlots(v.Elem(), fieldName, out)
		}
	case reflect.Struct:
		t := v.Type()
		for i := 0; i < v.NumField(); i++ {
			if t.Field(i).IsExported() {
				collectLinkedStringSlots(v.Field(i), t.Field(i).Name, out)
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			collectLinkedStringSlots(v.Index(i), fieldName, out)
		}
	case reflect.Map:
		if v.Type().Key().Kind() != reflect.String || v.IsNil() {
			return
		}
		mapValue := v
		elemType := v.Type().Elem()
		for _, key := range v.MapKeys() {
			elem := v.MapIndex(key)
			if elem.Kind() == reflect.Interface && !elem.IsNil() {
				elem = elem.Elem()
			}
			if elem.Kind() != reflect.String {
				continue
			}
			mapKey := key
			*out = append(*out, linkedStringSlot{
				value:   elem.String(),
				mapName: fieldName,
				key:     key.String(),
				set: func(next string) {
					mapValue.SetMapIndex(mapKey, reflect.ValueOf(next).Convert(elemType))
				},
			})
		}
	case reflect.String:
		if v.CanSet() {
			field := v
			*out = append(*out, linkedStringSlot{value: v.String(), set: func(next string) { field.SetString(next) }})
		}
	}
}

func linkedStringSlots(target any) []linkedStringSlot {
	var slots []linkedStringSlot
	collectLinkedStringSlots(reflect.ValueOf(target), "", &slots)
	return slots
}

func variableMentioned(texts []string, key string) bool {
	if key == "" {
		return false
	}
	pattern := regexp.MustCompile(`\{\{\s*` + regexp.QuoteMeta(key) + `\s*\}\}|["'` + "`" + `]` + regexp.QuoteMeta(key) + `["'` + "`" + `]`)
	for _, text := range texts {
		if strings.Contains(text, key) && pattern.MatchString(text) {
			return true
		}
	}
	return false
}

type linkedSecretPlan struct {
	slots []linkedStringSlot
	refs  []secretmgr.Ref
	use   []int
}

type RunnerSecretCheck struct {
	RequestID string             `json:"requestId"`
	HTTP      *model.HttpRequest `json:"http,omitempty"`
	GRPC      *model.GrpcRequest `json:"grpc,omitempty"`
}

type RunnerSecretCheckResult struct {
	RequestID string                      `json:"requestId"`
	Failures  []model.LinkedSecretFailure `json:"failures"`
}

func (a *App) PreflightCollectionRunner(workspaceID string, requests []RunnerSecretCheck) []RunnerSecretCheckResult {
	results := make([]RunnerSecretCheckResult, len(requests))
	requestRefs := make([][]secretmgr.Ref, len(requests))
	var refs []secretmgr.Ref
	for i, request := range requests {
		results[i] = RunnerSecretCheckResult{RequestID: request.RequestID, Failures: []model.LinkedSecretFailure{}}
		switch {
		case request.HTTP != nil && request.GRPC == nil:
			requestRefs[i] = planLinkedSecrets(request.HTTP).refs
		case request.GRPC != nil && request.HTTP == nil:
			requestRefs[i] = planLinkedSecrets(request.GRPC).refs
		default:
			results[i].Failures = []model.LinkedSecretFailure{{Kind: "invalid-request", Message: "Runner preflight requires exactly one HTTP or gRPC request"}}
		}
		refs = append(refs, requestRefs[i]...)
	}
	_, err := linkedSecrets.resolve(a.secretContext(), workspaceID, refs)
	if err == nil {
		return results
	}
	failures := linkedSecretFailures(err)
	if len(failures) == 0 {
		for i, refs := range requestRefs {
			if len(refs) != 0 {
				results[i].Failures = []model.LinkedSecretFailure{{Kind: "preflight-error", Message: err.Error()}}
			}
		}
		return results
	}
	byRef := make(map[secretmgr.Ref]model.LinkedSecretFailure, len(failures))
	for _, failure := range failures {
		ref := secretmgr.Ref{Provider: failure.Provider, Path: failure.Path, Field: failure.Field, Version: failure.Version}
		byRef[ref] = failure
	}
	for i, refs := range requestRefs {
		for _, ref := range refs {
			if failure, ok := byRef[ref]; ok {
				results[i].Failures = append(results[i].Failures, failure)
			}
		}
	}
	return results
}

func planLinkedSecrets(target any) linkedSecretPlan {
	slots := linkedStringSlots(target)
	plan := linkedSecretPlan{slots: slots}
	var texts []string
	var pending []int
	for index, slot := range slots {
		if linkedSecretVariableMaps[slot.mapName] {
			if secretmgr.ContainsMarker(slot.value) {
				pending = append(pending, index)
			} else {
				texts = append(texts, slot.value)
			}
			continue
		}
		texts = append(texts, slot.value)
		if secretmgr.ContainsMarker(slot.value) {
			plan.use = append(plan.use, index)
		}
	}
	for changed := true; changed; {
		changed = false
		remaining := pending[:0]
		for _, index := range pending {
			if variableMentioned(texts, slots[index].key) {
				plan.use = append(plan.use, index)
				texts = append(texts, slots[index].value)
				changed = true
			} else {
				remaining = append(remaining, index)
			}
		}
		pending = remaining
	}
	seen := map[secretmgr.Ref]bool{}
	for _, index := range plan.use {
		for _, ref := range secretmgr.FindMarkers(slots[index].value) {
			if !seen[ref] {
				seen[ref] = true
				plan.refs = append(plan.refs, ref)
			}
		}
	}
	return plan
}

func (p linkedSecretPlan) apply(values map[secretmgr.Ref]string) []string {
	for _, index := range p.use {
		slot := p.slots[index]
		slot.set(secretmgr.ReplaceMarkers(slot.value, values))
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" {
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}

func resolveLinkedSecretsIn(ctx context.Context, service *linkedSecretService, workspaceID string, target any) ([]string, error) {
	plan := planLinkedSecrets(target)
	if len(plan.refs) == 0 {
		return nil, nil
	}
	values, err := service.resolve(ctx, workspaceID, plan.refs)
	if err != nil {
		return nil, err
	}
	return plan.apply(values), nil
}

func linkedSecretFailures(err error) []model.LinkedSecretFailure {
	var resolveErr *secretmgr.ResolveError
	if !errors.As(err, &resolveErr) {
		return nil
	}
	out := make([]model.LinkedSecretFailure, 0, len(resolveErr.Failures))
	for _, failure := range resolveErr.Failures {
		item := model.LinkedSecretFailure{
			Provider: failure.Ref.Provider,
			Path:     failure.Ref.Path,
			Field:    failure.Ref.Field,
			Version:  failure.Ref.Version,
			Kind:     string(secretmgr.KindOf(failure.Err)),
			Message:  failure.Err.Error(),
		}
		var typed *secretmgr.Error
		if errors.As(failure.Err, &typed) {
			item.Message = typed.Message
		}
		out = append(out, item)
	}
	return out
}

func linkedSecretErrorMessage(err error) string {
	failures := linkedSecretFailures(err)
	if len(failures) == 0 {
		return "Request not sent: " + err.Error()
	}
	parts := make([]string, 0, len(failures))
	for _, failure := range failures {
		ref := failure.Provider + ":" + failure.Path
		if failure.Field != "" {
			ref += "#" + failure.Field
		}
		parts = append(parts, ref+" — "+failure.Message)
	}
	return "Request not sent: cannot get linked secrets: " + strings.Join(parts, "; ")
}

func redactLinkedSecretValues(target any, values []string) {
	if len(values) == 0 {
		return
	}
	variants := make([]string, 0, len(values)*3)
	for _, value := range values {
		if value == "" {
			continue
		}
		variants = append(variants, value, url.QueryEscape(value), url.PathEscape(value))
	}
	for _, slot := range linkedStringSlots(target) {
		if slot.value == "" {
			continue
		}
		if redacted := redactSecrets(slot.value, variants); redacted != slot.value {
			slot.set(redacted)
		}
	}
}

type linkedHTTPSecrets struct {
	values   []string
	duration float64
}

func (l linkedHTTPSecrets) finish(resp *model.HttpResponse) {
	if len(l.values) == 0 {
		return
	}
	redactLinkedSecretValues(resp, l.values)
	resp.Timings.Secrets = l.duration
}

func (a *App) linkSecretsIntoHTTP(ctx context.Context, req *model.HttpRequest) (linkedHTTPSecrets, *model.HttpResponse) {
	started := time.Now()
	values, err := resolveLinkedSecretsIn(ctx, linkedSecrets, req.WorkspaceID, req)
	elapsed := float64(time.Since(started).Microseconds()) / 1000
	if err != nil {
		return linkedHTTPSecrets{}, &model.HttpResponse{Error: linkedSecretErrorMessage(err), LinkedSecretFailures: linkedSecretFailures(err), Headers: []model.KeyValue{}, Timings: model.ResponseTime{Secrets: elapsed}}
	}
	if len(values) > 0 {
		req.SecretEnvironmentValues = append(req.SecretEnvironmentValues, values...)
	}
	return linkedHTTPSecrets{values: values, duration: elapsed}, nil
}

func (a *App) linkSecretsIntoRealtime(sessionID string, msg any) error {
	workspaceID, _ := a.realtimeWorkspaces.Load(sessionID)
	id, _ := workspaceID.(string)
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	_, err := resolveLinkedSecretsIn(ctx, linkedSecrets, id, msg)
	return err
}

var linkedRealtimeValues sync.Map

func emitRealtime(ctx context.Context, sessionID, name string, payload any) {
	runtime.EventsEmit(ctx, name, redactRealtimePayload(sessionID, payload))
}

func redactRealtimePayload(sessionID string, payload any) any {
	raw, ok := linkedRealtimeValues.Load(sessionID)
	if !ok || payload == nil {
		return payload
	}
	values, _ := raw.([]string)
	if len(values) == 0 {
		return payload
	}
	copied := reflect.New(reflect.TypeOf(payload))
	copied.Elem().Set(reflect.ValueOf(payload))
	redactLinkedSecretValues(copied.Interface(), values)
	return copied.Elem().Interface()
}

func rememberRealtimeSecrets(sessionID string, values []string) {
	if len(values) == 0 {
		linkedRealtimeValues.Delete(sessionID)
		return
	}
	linkedRealtimeValues.Store(sessionID, append([]string(nil), values...))
}
