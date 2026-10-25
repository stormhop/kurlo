package api

import (
	"fmt"
	"sync"
	"testing"

	"github.com/golang/protobuf/proto"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"google.golang.org/protobuf/types/known/emptypb"
)

func TestGrpcInvokeHandlerRecordsConcurrentBidiTraffic(t *testing.T) {
	resp := model.GrpcResponse{}
	handler := &grpcInvokeHandler{
		formatter: func(proto.Message) (string, error) { return "{}", nil },
		response:  &resp,
	}
	const perSide = 200
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < perSide; i++ {
			handler.OnSendMessage(fmt.Sprintf(`{"i":%d}`, i))
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < perSide; i++ {
			handler.OnReceiveResponse(&emptypb.Empty{})
		}
	}()
	wg.Wait()

	if len(resp.Messages) != 2*perSide {
		t.Fatalf("expected %d messages, got %d", 2*perSide, len(resp.Messages))
	}
	for i, msg := range resp.Messages {
		if msg.Index != i+1 {
			t.Fatalf("message %d has index %d", i, msg.Index)
		}
	}
}
