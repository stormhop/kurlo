package api

import (
	"sync"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const binaryResponseCacheSize = 4

type binaryResponseCache struct {
	mu     sync.Mutex
	order  []string
	bodies map[string]binaryResponseBody
}

type binaryResponseBody struct {
	data    []byte
	headers []model.KeyValue
}

func newBinaryResponseCache() *binaryResponseCache {
	return &binaryResponseCache{bodies: map[string]binaryResponseBody{}}
}

func (c *binaryResponseCache) put(requestID string, body binaryResponseBody) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.bodies[requestID]; exists {
		for i, id := range c.order {
			if id == requestID {
				c.order = append(c.order[:i], c.order[i+1:]...)
				break
			}
		}
	}
	c.bodies[requestID] = body
	c.order = append(c.order, requestID)
	for len(c.order) > binaryResponseCacheSize {
		delete(c.bodies, c.order[0])
		c.order = c.order[1:]
	}
}

func (c *binaryResponseCache) drop(requestID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.bodies[requestID]; !exists {
		return
	}
	delete(c.bodies, requestID)
	for i, id := range c.order {
		if id == requestID {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
}

func (c *binaryResponseCache) get(requestID string) (binaryResponseBody, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	body, ok := c.bodies[requestID]
	return body, ok
}

func (a *App) keepBinaryBodyOutOfTheWindow(requestID string, resp model.HttpResponse) model.HttpResponse {
	if a.binaryBodies == nil {
		return resp
	}
	if !resp.BodyIsBinary || requestID == "" {
		a.binaryBodies.drop(requestID)
		return resp
	}
	a.binaryBodies.put(requestID, binaryResponseBody{data: []byte(resp.Body), headers: resp.Headers})
	resp.Body = ""
	resp.BodyOmitted = true
	return resp
}

type SaveResponseBodyResult struct {
	SavedPath string `json:"savedPath"`
	Error     string `json:"error,omitempty"`
}

func (a *App) SaveResponseBody(requestID string, defaultName string) SaveResponseBodyResult {
	var body binaryResponseBody
	ok := false
	if a.binaryBodies != nil {
		body, ok = a.binaryBodies.get(requestID)
	}
	if !ok {
		return SaveResponseBodyResult{Error: "This response is no longer in memory. Send the request again to save it."}
	}
	if a.ctx == nil {
		return SaveResponseBodyResult{}
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: downloadFilename(defaultName, body.headers),
		Title:           "Save response",
	})
	if err != nil || path == "" {
		return SaveResponseBodyResult{}
	}
	if err := writeResponseBodyFile(path, body.data); err != nil {
		return SaveResponseBodyResult{Error: "failed to save response body: " + err.Error()}
	}
	return SaveResponseBodyResult{SavedPath: path}
}

func writeResponseBodyFile(path string, data []byte) error {
	sink, err := newResponseDownloadSink(path, nil)
	if err != nil {
		return err
	}
	if _, err := sink.writer.Write(data); err != nil {
		sink.abort()
		return err
	}
	if err := sink.commit(); err != nil {
		sink.abort()
		return err
	}
	return nil
}
