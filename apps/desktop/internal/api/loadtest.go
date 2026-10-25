package api

import (
	"github.com/stormhop/kurlo/apps/desktop/internal/loadtest"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func (a *App) ValidateLoadTest(test model.LoadTest, requests []model.LoadTestRequest) []string {
	problems := loadtest.Validate(test, requests)
	if problems == nil {
		return []string{}
	}
	return problems
}
