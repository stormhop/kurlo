package api

import (
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) ensureCookieSyncPreferences() {
	if a.cookieSync == nil {
		return
	}
	a.cookieSync.mu.Lock()
	if a.cookieSync.hydrated {
		a.cookieSync.mu.Unlock()
		return
	}
	a.cookieSync.hydrated = true
	a.cookieSync.mu.Unlock()

	preferences, err := loadAppPreferences()
	saved := cookieSyncPreferences{}
	if err == nil && preferences.CookieSync != nil {
		saved = *preferences.CookieSync
	}

	a.cookieSync.mu.Lock()
	a.cookieSync.enabled = saved.Enabled
	if saved.Port > 0 {
		a.cookieSync.port = saved.Port
	}
	a.cookieSync.domains = syncableCookieSyncDomains(saved.Domains)
	a.cookieSync.token = cookieSyncPreferencesToken(saved)
	minted := a.cookieSync.token == ""
	if minted {
		a.cookieSync.token = newCookieSyncToken()
	}
	a.cookieSync.mu.Unlock()

	if minted || saved.Token != "" {
		a.persistCookieSyncPreferences()
	}
}

func (a *App) persistCookieSyncPreferences() {
	if a.cookieSync == nil {
		return
	}
	a.cookieSync.mu.RLock()
	next := cookieSyncPreferences{
		Enabled: a.cookieSync.enabled,
		Port:    a.cookieSync.port,
		Domains: append([]string{}, a.cookieSync.domains...),
	}
	token := a.cookieSync.token
	a.cookieSync.mu.RUnlock()
	sealCookieSyncPreferencesToken(&next, token)

	preferences, err := loadAppPreferences()
	if err != nil {
		return
	}
	preferences.CookieSync = &next
	_ = saveAppPreferences(preferences)
}

func (a *App) CookieSyncStatus() model.CookieSyncStatus {
	if a.cookieSync == nil {
		return model.CookieSyncStatus{Error: "cookie sync is unavailable"}
	}
	a.ensureCookieSyncPreferences()
	return a.cookieSync.status()
}

func (a *App) StartCookieSync(config model.CookieSyncConfig, workspaceID string) model.CookieSyncStatus {
	if a.cookieSync == nil {
		return model.CookieSyncStatus{Error: "cookie sync is unavailable"}
	}
	a.ensureCookieSyncPreferences()
	status := a.cookieSync.start(config, workspaceID, a.emitCookieSyncStatus)
	a.persistCookieSyncPreferences()
	return status
}

func (a *App) StopCookieSync() model.CookieSyncStatus {
	if a.cookieSync == nil {
		return model.CookieSyncStatus{}
	}
	a.ensureCookieSyncPreferences()
	status := a.cookieSync.stop()
	a.persistCookieSyncPreferences()
	return status
}

func (a *App) SetCookieSyncDomains(domains []string) model.CookieSyncStatus {
	if a.cookieSync == nil {
		return model.CookieSyncStatus{Error: "cookie sync is unavailable"}
	}
	a.ensureCookieSyncPreferences()
	status := a.cookieSync.setDomains(domains)
	a.persistCookieSyncPreferences()
	return status
}

func (a *App) SetCookieSyncWorkspace(workspaceID string) model.CookieSyncStatus {
	if a.cookieSync == nil {
		return model.CookieSyncStatus{}
	}
	a.ensureCookieSyncPreferences()
	a.cookieSync.setWorkspace(workspaceID)
	return a.cookieSync.status()
}

func (a *App) RevokeCookieSyncPairing() model.CookieSyncStatus {
	if a.cookieSync == nil {
		return model.CookieSyncStatus{Error: "cookie sync is unavailable"}
	}
	a.ensureCookieSyncPreferences()
	status := a.cookieSync.revokePairing()
	a.persistCookieSyncPreferences()
	return status
}

func (a *App) ApproveCookieSyncPairing(requestID string) model.CookieSyncStatus {
	if a.cookieSync == nil {
		return model.CookieSyncStatus{Error: "cookie sync is unavailable"}
	}
	a.ensureCookieSyncPreferences()
	return a.cookieSync.approvePairing(requestID)
}

func (a *App) DenyCookieSyncPairing(requestID string) model.CookieSyncStatus {
	if a.cookieSync == nil {
		return model.CookieSyncStatus{Error: "cookie sync is unavailable"}
	}
	a.ensureCookieSyncPreferences()
	return a.cookieSync.denyPairing(requestID)
}

func (a *App) emitCookieSyncStatus(status model.CookieSyncStatus) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, "cookies:synced", status)
}
