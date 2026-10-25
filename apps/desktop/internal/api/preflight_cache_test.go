package api

import (
	"fmt"
	"testing"
	"time"
)

func TestPreflightCacheStaysBounded(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cache := newPreflightCache()
	cache.now = func() time.Time { return now }

	for i := 0; i < preflightCacheLimit+50; i++ {
		cache.store(fmt.Sprintf("key-%d", i), preflightCacheEntry{expiresAt: now.Add(time.Duration(i+1) * time.Second)})
	}
	if len(cache.entries) > preflightCacheLimit {
		t.Fatalf("cache grew to %d entries, limit is %d", len(cache.entries), preflightCacheLimit)
	}
	if _, ok := cache.lookup("key-0"); ok {
		t.Fatal("the entry closest to expiry should have been evicted first")
	}
	if _, ok := cache.lookup(fmt.Sprintf("key-%d", preflightCacheLimit+49)); !ok {
		t.Fatal("the newest entry should be kept")
	}
}
