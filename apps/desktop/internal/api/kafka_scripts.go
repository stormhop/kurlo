package api

import (
	"context"
	"encoding/json"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
)

func runKafkaRequest(ctx context.Context, req model.HttpRequest, sm *state.Manager, before model.ScriptResult, delta *environmentDelta) (model.HttpResponse, model.ScriptResult) {
	var hooks model.ScriptResult
	if req.Kafka.Mode != "consume" || req.Kafka.OnMessage == "" {
		return executeKafka(ctx, req, nil), hooks
	}
	scope := beginScriptScope(sm, collectionVariablesAfter(req.CollectionVariables, before), req.RequestVariables)
	populateScriptRequestContext(scope.ctx, req)
	scope.ctx.Send = newScriptSender(ctx, req.AllowSendRequest, req)
	run := func(record kafkaRecord) {
		scope.ctx.Tests, scope.ctx.Logs = nil, nil
		message, _ := json.Marshal(record)
		scope.ctx.KafkaMessage = string(message)
		result := redactRequestScriptResult(script.RunTests(req.Kafka.OnMessage, scope.ctx), req.Auth, req.SecretEnvironmentValues)
		hooks.Tests = append(hooks.Tests, result.Tests...)
		hooks.Logs = append(hooks.Logs, result.Logs...)
		if result.Error != "" && hooks.Error == "" {
			hooks.Error = result.Error
		}
		hooks.CollectionVariables, hooks.CollectionVariablesRemoved = mergeCollectionVariableResults(hooks, result)
	}
	resp := executeKafka(ctx, req, run)
	delta.merge(scope.commit(sm))
	return resp, hooks
}
