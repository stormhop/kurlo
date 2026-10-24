package api

import "strings"

type GitTokenInfoResult struct {
	Host     string `json:"host"`
	HasToken bool   `json:"hasToken"`
	Username string `json:"username"`
}

func (a *App) GitTokenInfo(remoteOrHost string) GitTokenInfoResult {
	host := normalizeGitHost(remoteOrHost)
	info := GitTokenInfoResult{Host: host}
	if host == "" {
		return info
	}
	if cred, ok := gitCredentialLookup(host); ok {
		info.HasToken = true
		info.Username = cred.Username
	}
	return info
}

func (a *App) GitStoreToken(remoteOrHost, username, token string) GitOperationResult {
	host := normalizeGitHost(remoteOrHost)
	if host == "" {
		return GitOperationResult{Ok: false, Error: "could not determine host from the remote URL"}
	}
	if strings.TrimSpace(token) == "" {
		return GitOperationResult{Ok: false, Error: "token is required"}
	}
	if err := gitCredentialSet(host, username, token); err != nil {
		return GitOperationResult{Ok: false, Error: "could not save token: " + err.Error()}
	}
	return GitOperationResult{Ok: true}
}

func (a *App) GitClearToken(remoteOrHost string) GitOperationResult {
	host := normalizeGitHost(remoteOrHost)
	if host == "" {
		return GitOperationResult{Ok: false, Error: "could not determine host"}
	}
	if err := gitCredentialErase(host); err != nil {
		return GitOperationResult{Ok: false, Error: "could not clear token: " + err.Error()}
	}
	return GitOperationResult{Ok: true}
}

func (a *App) GitSetSshKey(workspaceRoot, keyPath string) GitOperationResult {
	root := strings.TrimSpace(workspaceRoot)
	if root == "" {
		root = fileWorkspaceStorePath()
	}
	if root == "" {
		return GitOperationResult{Ok: false, Error: "workspace root is required"}
	}
	key := strings.TrimSpace(keyPath)
	cfg := gitWorkspaceAuth{}
	if key != "" {
		cfg = gitWorkspaceAuth{Method: "ssh-key", SSHKeyPath: key}
	}
	if err := saveWorkspaceAuth(root, cfg); err != nil {
		return GitOperationResult{Ok: false, Error: "could not save SSH key setting: " + err.Error()}
	}
	return GitOperationResult{Ok: true}
}

type GitAuthConfigResult struct {
	Method     string `json:"method"`
	SSHKeyPath string `json:"sshKeyPath"`
}

func (a *App) GitSshUrlFor(remoteURL string) string {
	if ssh, ok := httpsToSSHRemoteURL(remoteURL); ok {
		return ssh
	}
	return ""
}

func (a *App) GitRemoteUrl(remoteName string) string {
	gitOperationMu.RLock()
	defer gitOperationMu.RUnlock()
	status := gitStatusForWorkspace(fileWorkspaceStorePath())
	if !status.IsRepo || status.Root == "" {
		return ""
	}
	return gitRemoteURLForRoot(status.Root, remoteName)
}

func (a *App) GitSetRemoteUrl(remoteName, remoteURL string) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	status := gitStatusForWorkspace(fileWorkspaceStorePath())
	if !status.IsRepo || status.Root == "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Not a Git repository."}
	}
	name, err := cleanGitRemoteName(remoteName)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	url, err := cleanGitRemoteURL(remoteURL)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	if output, gerr := runGit(status.Root, "remote", "set-url", name, url); gerr != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(status.Root), Error: friendlyGitError("remote set-url", output, gerr), Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(status.Root)}
}

func (a *App) GitAuthConfig(workspaceRoot string) GitAuthConfigResult {
	root := strings.TrimSpace(workspaceRoot)
	if root == "" {
		root = fileWorkspaceStorePath()
	}
	cfg := loadWorkspaceAuth(root)
	return GitAuthConfigResult{Method: cfg.Method, SSHKeyPath: cfg.SSHKeyPath}
}
