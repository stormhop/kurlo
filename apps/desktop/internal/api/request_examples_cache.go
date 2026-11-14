package api

import (
	"bytes"
	"encoding/json"
	"sync"
)

const exampleCountField = "exampleCount"

type requestExamplesCache struct {
	mu      sync.Mutex
	roots   map[string]map[string]json.RawMessage
	pending map[string]chan struct{}
	broken  map[string]bool
}

var loadedRequestExamples = &requestExamplesCache{roots: map[string]map[string]json.RawMessage{}}

func (c *requestExamplesCache) replace(root string, examples map[string]json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.pending, root)
	c.roots[root] = examples
}

func (c *requestExamplesCache) forget(root string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.pending, root)
	delete(c.roots, root)
}

func (c *requestExamplesCache) loadLater(root string, deferred *deferredRequestExamples, broken func()) {
	done := make(chan struct{})
	c.mu.Lock()
	delete(c.roots, root)
	if c.pending == nil {
		c.pending = map[string]chan struct{}{}
	}
	c.pending[root] = done
	c.mu.Unlock()
	go func() {
		examples, healthy := deferred.load(root)
		c.mu.Lock()
		current := c.pending[root] == done
		if current {
			delete(c.pending, root)
			if healthy {
				c.roots[root] = examples
			} else {
				if c.broken == nil {
					c.broken = map[string]bool{}
				}
				c.broken[root] = true
			}
		}
		c.mu.Unlock()
		close(done)
		if current && !healthy && broken != nil {
			broken()
		}
	}()
}

func (c *requestExamplesCache) await(root string) (map[string]json.RawMessage, bool, error) {
	for {
		c.mu.Lock()
		if examples, ok := c.roots[root]; ok {
			c.mu.Unlock()
			return examples, true, nil
		}
		done, loading := c.pending[root]
		broken := c.broken[root]
		c.mu.Unlock()
		if loading {
			<-done
			continue
		}
		if broken {
			return nil, false, errRequestExamplesNeedReload
		}
		return nil, false, nil
	}
}

func (c *requestExamplesCache) needsEagerLoad(root string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.broken[root]
}

func (c *requestExamplesCache) healthy(root string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.broken, root)
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

func keepUnchangedRequestExamples(store map[string]any, cached map[string]json.RawMessage) map[string]json.RawMessage {
	kept := map[string]json.RawMessage{}
	for _, request := range mapSlice(store["requests"]) {
		delete(request, exampleCountField)
		id := stringValue(request, "id")
		encoded, ok := cached[id]
		if !ok {
			continue
		}
		raw, sent := request["examples"]
		if sent {
			again, err := json.Marshal(raw)
			if err != nil || !bytes.Equal(again, encoded) {
				continue
			}
			delete(request, "examples")
		}
		kept[id] = encoded
	}
	return kept
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
