package state

import (
	"sync"

	"github.com/stormhop/kurlo/apps/desktop/internal/util"
)

type Manager struct {
	mu          sync.RWMutex
	variables   map[string]string
	environment map[string]string
	collections map[string]map[string]string
}

func New() *Manager {
	return &Manager{
		variables:   make(map[string]string),
		environment: make(map[string]string),
		collections: make(map[string]map[string]string),
	}
}

func (m *Manager) GetVariables() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return util.CloneMap(m.variables)
}

func (m *Manager) GetEnvironment() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return util.CloneMap(m.environment)
}

func (m *Manager) SetVariable(key, value string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.variables[key] = value
}

func (m *Manager) SetEnvironmentVar(key, value string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.environment[key] = value
}

func (m *Manager) SetEnvironment(values map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.environment = util.CloneMap(values)
}

func (m *Manager) SetVariables(values map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.variables = util.CloneMap(values)
}

func (m *Manager) DeleteVariable(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.variables, key)
}

func (m *Manager) ClearVariables() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.variables = make(map[string]string)
}

func (m *Manager) Snapshot() (variables, environment map[string]string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return util.CloneMap(m.variables), util.CloneMap(m.environment)
}

func (m *Manager) Merge(beforeVars, afterVars, beforeEnv, afterEnv map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mergeMapDelta(m.variables, beforeVars, afterVars)
	mergeMapDelta(m.environment, beforeEnv, afterEnv)
}

func mergeMapDelta(live, before, after map[string]string) {
	for key, value := range after {
		if prev, ok := before[key]; !ok || prev != value {
			live[key] = value
		}
	}
	for key := range before {
		if _, ok := after[key]; !ok {
			delete(live, key)
		}
	}
}

func (m *Manager) GetCollectionVariables(id string) (map[string]string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	values, ok := m.collections[id]
	return util.CloneMap(values), ok
}

func (m *Manager) SetCollectionVariables(id string, values map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.collections == nil {
		m.collections = make(map[string]map[string]string)
	}
	m.collections[id] = util.CloneMap(values)
}

func (m *Manager) EnsureCollectionVariables(id string, defaults map[string]string) map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.collections == nil {
		m.collections = make(map[string]map[string]string)
	}
	if _, exists := m.collections[id]; !exists {
		m.collections[id] = util.CloneMap(defaults)
	}
	return util.CloneMap(m.collections[id])
}

func (m *Manager) ApplyCollectionVariableChanges(id string, updates map[string]string, removed []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.collections == nil {
		m.collections = make(map[string]map[string]string)
	}
	values := m.collections[id]
	if values == nil {
		values = map[string]string{}
		m.collections[id] = values
	}
	for key, value := range updates {
		values[key] = value
	}
	for _, key := range removed {
		delete(values, key)
	}
}
