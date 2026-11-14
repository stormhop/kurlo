package api

import (
	"fmt"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func seedAgentActivity(t *testing.T, count int, now time.Time) {
	t.Helper()
	for index := 0; index < count; index++ {
		at := now.Add(-time.Duration(index) * time.Hour)
		status := "ok"
		if index%10 == 0 {
			status = "error"
		}
		files := []string{}
		if index%4 == 0 {
			files = []string{fmt.Sprintf("collections/API/requests/R-%d.yml", index)}
		}
		entry := model.AgentActivityEntry{AgentActivitySummary: model.AgentActivitySummary{
			ID: newAgentActivityID(at), Time: at.UnixMilli(), Client: "Kurlo agent", Tool: fmt.Sprintf("tool_%d", index), Status: status, Files: files,
		}}
		if err := writeAgentActivity(entry); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAgentActivityPagesThroughEveryStoredEntry(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	now := time.Now()
	seedAgentActivity(t, 250, now)
	app := NewApp()

	seen := map[string]bool{}
	filter := model.AgentActivityFilter{Limit: 100}
	pages := []int{}
	for {
		page := app.AgentActivity(filter)
		if page.Error != "" {
			t.Fatal(page.Error)
		}
		pages = append(pages, len(page.Entries))
		for _, entry := range page.Entries {
			if seen[entry.ID] {
				t.Fatalf("entry %s came twice", entry.ID)
			}
			seen[entry.ID] = true
		}
		if !page.HasMore {
			break
		}
		filter.Before = page.Entries[len(page.Entries)-1].ID
	}
	if fmt.Sprint(pages) != "[100 100 50]" || len(seen) != 250 {
		t.Fatalf("pages = %v, seen %d", pages, len(seen))
	}

	found := app.AgentActivity(model.AgentActivityFilter{Limit: 100, Text: "R-248"})
	if len(found.Entries) != 1 || found.Entries[0].Tool != "tool_248" || found.HasMore {
		t.Fatalf("search should reach the oldest entries: %+v", found.Entries)
	}

	week := now.Add(-7 * 24 * time.Hour).UnixMilli()
	today := now.Add(-5*time.Hour - time.Minute).UnixMilli()
	first := app.AgentActivity(model.AgentActivityFilter{Limit: 100, OverviewSince: week, TodaySince: today})
	overview := first.Overview
	if overview == nil {
		t.Fatal("first page has no overview")
	}
	inWeek := 0
	errors := 0
	changed := 0
	for index := 0; index < 250; index++ {
		if now.Add(-time.Duration(index)*time.Hour).UnixMilli() < week {
			continue
		}
		inWeek++
		if index%10 == 0 {
			errors++
		}
		if index%4 == 0 {
			changed++
		}
	}
	if overview.Week != inWeek || overview.Today != 6 || overview.Errors != errors || overview.Changed != changed || len(overview.Changes) != 5 || len(overview.Problems) != 5 {
		t.Fatalf("overview = %+v, want week %d errors %d changed %d", overview, inWeek, errors, changed)
	}
}

func TestAgentActivitySearchMatchesWordsFilesBranchAndClient(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	now := time.Now()
	entries := []model.AgentActivitySummary{
		{ID: newAgentActivityID(now.Add(-time.Hour)), Time: now.Add(-time.Hour).UnixMilli(), Client: "Kurlo agent", Tool: "save_request", Status: "ok", Files: []string{"workspaces/Demo/collections/Shop/requests/Create-order.yml"}, Commit: "abc1234", Branch: "kurlo-agent/orders-1a2b3c"},
		{ID: newAgentActivityID(now.Add(-2 * time.Hour)), Time: now.Add(-2 * time.Hour).UnixMilli(), Client: "Claude Code", Tool: "list_requests", Status: "ok", Files: []string{}},
	}
	for _, entry := range entries {
		if err := writeAgentActivity(model.AgentActivityEntry{AgentActivitySummary: entry}); err != nil {
			t.Fatal(err)
		}
	}
	app := NewApp()
	tools := func(filter model.AgentActivityFilter) string {
		var out []string
		for _, entry := range app.AgentActivity(filter).Entries {
			out = append(out, entry.Tool)
		}
		return fmt.Sprint(out)
	}
	for _, search := range []string{"create order", "Create-Order", "orders-1a2b3c", "abc1234"} {
		if got := tools(model.AgentActivityFilter{Text: search}); got != "[save_request]" {
			t.Fatalf("search %q = %s", search, got)
		}
	}
	if got := tools(model.AgentActivityFilter{Text: "delete"}); got != "[]" {
		t.Fatalf("unmatched search = %s", got)
	}
	if got := tools(model.AgentActivityFilter{Client: "Claude Code"}); got != "[list_requests]" {
		t.Fatalf("client filter = %s", got)
	}
}
