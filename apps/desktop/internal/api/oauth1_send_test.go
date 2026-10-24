package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestSendRequestSignsWithOAuth1InEveryPlacement(t *testing.T) {
	var got *http.Request
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		got = r
		gotBody = r.PostForm.Encode()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	send := func(addTo string) model.HttpResponse {
		return NewApp().SendRequest(model.HttpRequest{
			Method: http.MethodPost,
			URL:    server.URL + "/items?page=2",
			Auth: model.AuthConfig{
				Type: "oauth1", OAuth1ConsumerKey: "key", OAuth1ConsumerSecret: "secret",
				OAuth1Token: "token", OAuth1TokenSecret: "token-secret", OAuth1AddTo: addTo,
			},
			BodyType:              "urlencoded",
			FormData:              []model.KeyValue{{Key: "name", Value: "kurlo", Enabled: true}},
			FollowRedirects:       true,
			TimeoutMs:             5000,
			HTTPVersion:           "auto",
			EnableSSLVerification: true,
			MaxRedirects:          10,
		})
	}

	if resp := send("header"); resp.Error != "" {
		t.Fatalf("header: %s", resp.Error)
	}
	if h := got.Header.Get("Authorization"); !strings.HasPrefix(h, "OAuth ") || !strings.Contains(h, `oauth_consumer_key="key"`) || !strings.Contains(h, "oauth_signature=") {
		t.Fatalf("Authorization = %q", h)
	}

	if resp := send("query"); resp.Error != "" {
		t.Fatalf("query: %s", resp.Error)
	}
	if q := got.URL.Query(); q.Get("oauth_signature") == "" || q.Get("page") != "2" {
		t.Fatalf("query = %q", got.URL.RawQuery)
	}

	if resp := send("body"); resp.Error != "" {
		t.Fatalf("body: %s", resp.Error)
	}
	if got.PostForm.Get("oauth_signature") == "" || got.PostForm.Get("name") != "kurlo" {
		t.Fatalf("body = %q", gotBody)
	}
}
