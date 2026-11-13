package api

import (
	"encoding/json"
	"sync"
)

const exampleCountField = "exampleCount"

type requestExamplesCache struct {
	mu    sync.Mutex
	roots map[string]map[string]json.RawMessage
}

var loadedRequestExamples = &requestExamplesCache{roots: map[string]map[string]json.RawMessage{}}

func (c *requestExamplesCache) replace(root string, examples map[string]json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.roots[root] = examples
}

func (c *requestExamplesCache) snapshot(root string) (map[string]json.RawMessage, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	examples, ok := c.roots[root]
	return examples, ok
}

func (c *requestExamplesCache) forget(root string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.roots, root)
}

func moveRequestExamplesOut(store map[string]any) map[string]json.RawMessage {
	examples := map[string]json.RawMessage{}
	for _, request := range mapSlice(store["requests"]) {
		id := stringValue(request, "id")
		raw, ok := request["examples"]
		delete(request, "examples")
		count := 0
		if list, isList := raw.([]any); isList {
			count = len(list)
		} else if list, isList := raw.([]map[string]any); isList {
			count = len(list)
		}
		if id == "" || !ok || count == 0 {
			continue
		}
		encoded, err := json.Marshal(raw)
		if err != nil {
			request["examples"] = raw
			continue
		}
		examples[id] = encoded
		request[exampleCountField] = count
	}
	return examples
}

func attachUnloadedRequestExamples(store map[string]any, cached map[string]json.RawMessage) error {
	for _, request := range mapSlice(store["requests"]) {
		delete(request, exampleCountField)
		if _, sent := request["examples"]; sent {
			continue
		}
		encoded, ok := cached[stringValue(request, "id")]
		if !ok {
			continue
		}
		var examples []any
		if err := json.Unmarshal(encoded, &examples); err != nil {
			return err
		}
		request["examples"] = examples
	}
	return nil
}

func requestExamplesAfterSave(store map[string]any, previous map[string]json.RawMessage) map[string]json.RawMessage {
	examples := make(map[string]json.RawMessage, len(previous))
	for id, encoded := range previous {
		examples[id] = encoded
	}
	for _, request := range mapSlice(store["requests"]) {
		id := stringValue(request, "id")
		raw, ok := request["examples"]
		if id == "" || !ok {
			continue
		}
		if list, isList := raw.([]any); isList && len(list) == 0 {
			delete(examples, id)
			continue
		}
		if encoded, err := json.Marshal(raw); err == nil {
			examples[id] = encoded
		}
	}
	return examples
}
