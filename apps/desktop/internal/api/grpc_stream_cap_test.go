package api

import (
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestLongGrpcStreamKeepsOnlyTheLatestMessages(t *testing.T) {
	resp := model.GrpcResponse{}
	handler := &grpcInvokeHandler{requestID: "req", startedAt: time.Now(), response: &resp}
	total := 5*grpcKeptMessages + 7
	for range total {
		handler.appendMessage(model.GrpcMessage{Direction: "incoming", Body: "{}", Size: 2}, true)
		if len(resp.Messages) >= 2*grpcKeptMessages {
			t.Fatalf("kept %d messages while streaming", len(resp.Messages))
		}
	}
	kept := keepLatestGrpcMessages(resp.Messages, grpcKeptMessages)
	if len(kept) != grpcKeptMessages || kept[len(kept)-1].Index != total || kept[0].Index != total-grpcKeptMessages+1 {
		t.Fatalf("kept %d messages, first #%d, last #%d", len(kept), kept[0].Index, kept[len(kept)-1].Index)
	}
	if resp.Size != int64(2*total) {
		t.Fatalf("size = %d, want every received byte counted", resp.Size)
	}
}
