package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"gopkg.in/yaml.v3"
)

const (
	agentActivityDirName      = "agent-activity"
	agentActivityRetention    = 30 * 24 * time.Hour
	agentActivityMaxEntries   = 2000
	agentActivityDefaultLimit = 200
	agentActivityTextLimit    = 16 * 1024
)

var agentActivityMu sync.Mutex

func agentActivityDir() string {
	return filepath.Join(requestStoreDir(), agentActivityDirName)
}

func agentActivityEnabled() bool {
	preferences, err := loadAppPreferences()
	return err != nil || !preferences.AgentActivityOff
}

func newAgentActivityID(at time.Time) string {
	return fmt.Sprintf("%013d-%s", at.UnixMilli(), strings.ReplaceAll(uuid.NewString(), "-", "")[:12])
}

func agentActivityPath(id string) (string, error) {
	if id == "" {
		return "", errors.New("activity id is empty")
	}
	for _, ch := range id {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9', ch == '-':
		default:
			return "", fmt.Errorf("invalid activity id %q", id)
		}
	}
	return filepath.Join(agentActivityDir(), id+".json"), nil
}

func agentActivityTime(id string) int64 {
	var millis int64
	if _, err := fmt.Sscanf(id, "%013d-", &millis); err != nil {
		return 0
	}
	return millis
}

func agentActivitySecrets() []string {
	store, _, err := loadLocalRequestStore(requestStorePath())
	if err != nil || store == nil {
		return nil
	}
	var secrets []string
	for _, value := range stringMap(store["secrets"]) {
		secrets = append(secrets, value)
	}
	for _, row := range mapSlice(store["globals"]) {
		if boolValue(row["secret"]) {
			secrets = append(secrets, stringValue(row, "value"))
		}
	}
	return secrets
}

func agentActivityText(text string, secrets []string) string {
	text = redactSecrets(text, secrets)
	if len(text) > agentActivityTextLimit {
		text = text[:agentActivityTextLimit] + "\n[truncated]"
	}
	return text
}

func writeAgentActivity(entry model.AgentActivityEntry) error {
	agentActivityMu.Lock()
	defer agentActivityMu.Unlock()
	if entry.ID == "" {
		now := time.Now()
		entry.ID = newAgentActivityID(now)
		entry.Time = now.UnixMilli()
	}
	if entry.Files == nil {
		entry.Files = []string{}
	}
	if entry.Changes == nil {
		entry.Changes = []model.AgentFileChange{}
	}
	path, err := agentActivityPath(entry.ID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(agentActivityDir(), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	encrypted, err := encryptRequestStorePayload(payload)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(path, encrypted); err != nil {
		return err
	}
	pruneAgentActivity(time.Now())
	return nil
}

func agentActivityIDs() ([]string, error) {
	entries, err := os.ReadDir(agentActivityDir())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		ids = append(ids, strings.TrimSuffix(name, ".json"))
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ids)))
	return ids, nil
}

func pruneAgentActivity(now time.Time) {
	ids, err := agentActivityIDs()
	if err != nil {
		return
	}
	cutoff := now.Add(-agentActivityRetention).UnixMilli()
	for index, id := range ids {
		if index < agentActivityMaxEntries && agentActivityTime(id) >= cutoff {
			continue
		}
		if path, err := agentActivityPath(id); err == nil {
			_ = os.Remove(path)
		}
	}
}

func readAgentActivity(id string) (model.AgentActivityEntry, error) {
	var entry model.AgentActivityEntry
	path, err := agentActivityPath(id)
	if err != nil {
		return entry, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return entry, fmt.Errorf("activity %s is no longer in the log", id)
		}
		return entry, err
	}
	payload, err := decryptRequestStorePayload(data)
	if err != nil {
		return entry, err
	}
	if err := json.Unmarshal(payload, &entry); err != nil {
		return entry, err
	}
	return entry, nil
}

const agentActivityOverviewItems = 5

func listAgentActivity(filter model.AgentActivityFilter) ([]model.AgentActivitySummary, error) {
	page, err := pageAgentActivity(filter)
	return page.Entries, err
}

func agentActivityMatchesText(entry model.AgentActivitySummary, words []string) bool {
	if len(words) == 0 {
		return true
	}
	haystack := strings.ToLower(strings.Join(append([]string{entry.Tool, entry.Client, entry.Status, entry.Error, entry.Branch, entry.Commit}, entry.Files...), " "))
	for _, word := range words {
		if !strings.Contains(haystack, word) {
			return false
		}
	}
	return true
}

func countAgentActivityOverview(overview *model.AgentActivityOverview, entry model.AgentActivitySummary, todaySince int64) {
	overview.Week++
	if entry.Time >= todaySince {
		overview.Today++
	}
	if entry.Status == "error" {
		overview.Errors++
	}
	if len(entry.Files) > 0 && entry.Status != "declined" {
		overview.Changed++
		if len(overview.Changes) < agentActivityOverviewItems {
			overview.Changes = append(overview.Changes, entry)
		}
	}
	if (entry.Status == "error" || entry.Status == "declined") && len(overview.Problems) < agentActivityOverviewItems {
		overview.Problems = append(overview.Problems, entry)
	}
}

func pageAgentActivity(filter model.AgentActivityFilter) (model.AgentActivityList, error) {
	agentActivityMu.Lock()
	defer agentActivityMu.Unlock()
	page := model.AgentActivityList{Entries: []model.AgentActivitySummary{}}
	ids, err := agentActivityIDs()
	if err != nil {
		return page, err
	}
	limit := filter.Limit
	if limit <= 0 || limit > agentActivityMaxEntries {
		limit = agentActivityDefaultLimit
	}
	var overview *model.AgentActivityOverview
	if filter.OverviewSince > 0 {
		overview = &model.AgentActivityOverview{Changes: []model.AgentActivitySummary{}, Problems: []model.AgentActivitySummary{}}
		page.Overview = overview
	}
	words := strings.Fields(strings.ToLower(filter.Text))
	currentRoot := agentWorkspaceKey(fileWorkspaceStorePath())
	names := activityWorkspaceNames{}
	for _, id := range ids {
		at := agentActivityTime(id)
		pageDone := page.HasMore
		if pageDone && (overview == nil || at < filter.OverviewSince) {
			break
		}
		if filter.Since > 0 && at < filter.Since && (overview == nil || at < filter.OverviewSince) {
			break
		}
		inOverview := overview != nil && at >= filter.OverviewSince
		inPage := !pageDone && (filter.Before == "" || id < filter.Before) && (filter.Until <= 0 || at <= filter.Until) && (filter.Since <= 0 || at >= filter.Since)
		if !inOverview && !inPage {
			continue
		}
		entry, err := readAgentActivity(id)
		if err != nil {
			continue
		}
		entry.Here = filter.WorkspaceID != "" && entry.WorkspaceID == filter.WorkspaceID && entry.Workspace != "" && agentWorkspaceKey(entry.Workspace) == currentRoot
		if !filter.AllWorkspaces && filter.WorkspaceID != "" && !entry.Here {
			continue
		}
		if !entry.Here {
			entry.WorkspaceName = names.lookup(entry.Workspace, entry.WorkspaceID)
		}
		if inOverview {
			countAgentActivityOverview(overview, entry.AgentActivitySummary, filter.TodaySince)
		}
		if !inPage {
			continue
		}
		if filter.Client != "" && !strings.EqualFold(entry.Client, filter.Client) {
			continue
		}
		if filter.Tool != "" && entry.Tool != filter.Tool {
			continue
		}
		if !agentActivityMatchesText(entry.AgentActivitySummary, words) {
			continue
		}
		if len(page.Entries) >= limit {
			page.HasMore = true
			continue
		}
		page.Entries = append(page.Entries, entry.AgentActivitySummary)
	}
	return page, nil
}

func revertAgentActivity(id, path string) (model.AgentActivityEntry, error) {
	agentActivityMu.Lock()
	defer agentActivityMu.Unlock()
	entry, err := readAgentActivity(id)
	if err != nil {
		return entry, err
	}
	root := entry.Workspace
	if strings.TrimSpace(root) == "" || len(entry.Changes) == 0 {
		return entry, errors.New("this activity did not change any files")
	}
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return entry, err
	}
	defer unlock()
	current, err := readWorkspaceFileContents(root)
	if err != nil {
		return entry, err
	}
	var targets []int
	for index, change := range entry.Changes {
		if change.Reverted || (path != "" && change.Path != path) {
			continue
		}
		if change.TooLarge {
			return entry, fmt.Errorf("%s was too large to keep in the log, so it cannot be restored from here", change.Path)
		}
		now, exists := current[change.Path]
		if exists != (change.After != nil) || (change.After != nil && string(now) != *change.After) {
			return entry, fmt.Errorf("%s has changed since then, so it was not restored; restore it from Git instead", change.Path)
		}
		targets = append(targets, index)
	}
	if len(targets) == 0 {
		if path != "" {
			return entry, fmt.Errorf("%s is not part of this activity or is already restored", path)
		}
		return entry, errors.New("there is nothing left to restore")
	}
	for _, index := range targets {
		change := entry.Changes[index]
		target := filepath.Join(root, filepath.FromSlash(change.Path))
		if change.Before == nil {
			if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
				return entry, err
			}
			removeEmptyWorkspaceDirs(root, filepath.Dir(target))
		} else {
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return entry, err
			}
			if err := writeTextFileAtomic(target, []byte(*change.Before)); err != nil {
				return entry, err
			}
		}
		entry.Changes[index].Reverted = true
	}
	entry.Reverted = true
	for _, change := range entry.Changes {
		if !change.Reverted && !change.TooLarge {
			entry.Reverted = false
		}
	}
	activityPath, err := agentActivityPath(entry.ID)
	if err != nil {
		return entry, err
	}
	payload, err := json.Marshal(entry)
	if err != nil {
		return entry, err
	}
	encrypted, err := encryptRequestStorePayload(payload)
	if err != nil {
		return entry, err
	}
	return entry, writeFileAtomic(activityPath, encrypted)
}

type activityWorkspaceNames map[string]map[string]string

func (n activityWorkspaceNames) lookup(root, workspaceID string) string {
	if root == "" || workspaceID == "" {
		return ""
	}
	key := agentWorkspaceKey(root)
	byID, ok := n[key]
	if !ok {
		byID = map[string]string{}
		dirs, _ := os.ReadDir(filepath.Join(root, fileStoreWorkspacesDir))
		for _, dir := range dirs {
			if !dir.IsDir() {
				continue
			}
			data, err := os.ReadFile(filepath.Join(root, fileStoreWorkspacesDir, dir.Name(), fileStoreRootFileName))
			if err != nil {
				continue
			}
			var doc struct {
				Workspace struct {
					ID   string `yaml:"id"`
					Name string `yaml:"name"`
				} `yaml:"workspace"`
			}
			if yaml.Unmarshal(data, &doc) == nil && doc.Workspace.ID != "" {
				byID[doc.Workspace.ID] = doc.Workspace.Name
			}
		}
		n[key] = byID
	}
	return byID[workspaceID]
}

func (a *App) AgentActivity(filter model.AgentActivityFilter) model.AgentActivityList {
	out, err := pageAgentActivity(filter)
	out.Enabled = agentActivityEnabled()
	if err != nil {
		out.Error = err.Error()
	}
	return out
}

func (a *App) AgentActivityEntry(id string) (model.AgentActivityEntry, error) {
	agentActivityMu.Lock()
	defer agentActivityMu.Unlock()
	return readAgentActivity(id)
}

func (a *App) RevertAgentActivity(id, path string) (model.AgentActivityEntry, error) {
	return revertAgentActivity(id, path)
}

func (a *App) SetAgentActivityEnabled(enabled bool) model.AgentResult {
	aiConnectionsMu.Lock()
	defer aiConnectionsMu.Unlock()
	preferences, err := loadAppPreferences()
	if err != nil {
		return model.AgentResult{Error: fmt.Sprintf("Kurlo could not read its settings: %v", err)}
	}
	preferences.AgentActivityOff = !enabled
	if err := saveAppPreferences(preferences); err != nil {
		return model.AgentResult{Error: fmt.Sprintf("Kurlo could not save its settings: %v", err)}
	}
	return model.AgentResult{Ok: true}
}

func (a *App) ClearAgentActivity() model.AgentResult {
	agentActivityMu.Lock()
	defer agentActivityMu.Unlock()
	if err := os.RemoveAll(agentActivityDir()); err != nil {
		return model.AgentResult{Error: err.Error()}
	}
	return model.AgentResult{Ok: true}
}
