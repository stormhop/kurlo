package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

func httpsToSSHRemoteURL(remoteURL string) (string, bool) {
	raw := strings.TrimSpace(remoteURL)
	if raw == "" {
		return "", false
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "git@") || strings.HasPrefix(lower, "ssh://") {
		return raw, true
	}
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	host := u.Hostname()
	path := strings.TrimPrefix(u.Path, "/")
	if host == "" || path == "" {
		return "", false
	}
	user := "git"
	if u.User != nil && u.User.Username() != "" {
		user = u.User.Username()
	}
	return user + "@" + host + ":" + path, true
}

const (
	gitCredentialsFileName = "git-credentials.enc"
	gitAuthConfigFileName  = "git-auth.json"
)

type gitCredential struct {
	Username string `json:"username"`
	Token    string `json:"token"`
}

type gitWorkspaceAuth struct {
	Method     string `json:"method"`
	SSHKeyPath string `json:"sshKeyPath"`
}

var gitCredentialsMu sync.Mutex

func gitCredentialsPath() string { return filepath.Join(requestStoreDir(), gitCredentialsFileName) }
func gitAuthConfigPath() string  { return filepath.Join(requestStoreDir(), gitAuthConfigFileName) }

func normalizeGitHost(host string) string {
	host = strings.TrimSpace(strings.ToLower(host))
	host = strings.TrimPrefix(host, "ssh://")
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")
	if at := strings.LastIndex(host, "@"); at >= 0 {
		host = host[at+1:]
	}
	if slash := strings.IndexAny(host, "/:"); slash >= 0 {
		host = host[:slash]
	}
	return host
}

func loadGitCredentials() (map[string]gitCredential, error) {
	creds := map[string]gitCredential{}
	data, err := os.ReadFile(gitCredentialsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return creds, nil
		}
		return creds, err
	}
	if len(data) == 0 {
		return creds, nil
	}
	plaintext, err := decryptRequestStorePayload(data)
	if err != nil {
		return creds, err
	}
	if err := json.Unmarshal(plaintext, &creds); err != nil {
		return map[string]gitCredential{}, err
	}
	return creds, nil
}

func saveGitCredentials(creds map[string]gitCredential) error {
	payload, err := json.Marshal(creds)
	if err != nil {
		return err
	}
	envelope, err := encryptRequestStorePayload(payload)
	if err != nil {
		return err
	}
	dir := requestStoreDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return writeFileAtomic(gitCredentialsPath(), envelope)
}

func gitCredentialLookup(host string) (gitCredential, bool) {
	cred, ok, _ := gitCredentialLookupErr(host)
	return cred, ok
}

func gitCredentialLookupErr(host string) (gitCredential, bool, error) {
	host = normalizeGitHost(host)
	if host == "" {
		return gitCredential{}, false, nil
	}
	gitCredentialsMu.Lock()
	defer gitCredentialsMu.Unlock()
	creds, err := loadGitCredentials()
	if err != nil {
		return gitCredential{}, false, err
	}
	cred, ok := creds[host]
	if !ok || strings.TrimSpace(cred.Token) == "" {
		return gitCredential{}, false, nil
	}
	return cred, true, nil
}

func gitCredentialSet(host, username, token string) error {
	host = normalizeGitHost(host)
	if host == "" {
		return fmt.Errorf("host is required")
	}
	if strings.TrimSpace(token) == "" {
		return fmt.Errorf("token is required")
	}
	gitCredentialsMu.Lock()
	defer gitCredentialsMu.Unlock()
	creds, err := loadGitCredentials()
	if err != nil {
		return fmt.Errorf("could not read existing git credentials: %w", err)
	}
	creds[host] = gitCredential{Username: strings.TrimSpace(username), Token: token}
	return saveGitCredentials(creds)
}

func gitCredentialErase(host string) error {
	host = normalizeGitHost(host)
	if host == "" {
		return nil
	}
	gitCredentialsMu.Lock()
	defer gitCredentialsMu.Unlock()
	creds, err := loadGitCredentials()
	if err != nil {
		return err
	}
	if len(creds) == 0 {
		return nil
	}
	if _, ok := creds[host]; !ok {
		return nil
	}
	delete(creds, host)
	return saveGitCredentials(creds)
}

func gitCredentialHasToken(host string) bool {
	_, ok := gitCredentialLookup(host)
	return ok
}

func loadWorkspaceAuthAll() map[string]gitWorkspaceAuth {
	out := map[string]gitWorkspaceAuth{}
	data, err := os.ReadFile(gitAuthConfigPath())
	if err != nil || len(data) == 0 {
		return out
	}
	_ = json.Unmarshal(data, &out)
	return out
}

func loadWorkspaceAuth(root string) gitWorkspaceAuth {
	root = strings.TrimSpace(root)
	if root == "" {
		return gitWorkspaceAuth{}
	}
	return loadWorkspaceAuthAll()[root]
}

func saveWorkspaceAuth(root string, cfg gitWorkspaceAuth) error {
	root = strings.TrimSpace(root)
	if root == "" {
		return fmt.Errorf("workspace root is required")
	}
	gitCredentialsMu.Lock()
	defer gitCredentialsMu.Unlock()
	all := loadWorkspaceAuthAll()
	if cfg.Method == "" && cfg.SSHKeyPath == "" {
		delete(all, root)
	} else {
		all[root] = cfg
	}
	payload, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(requestStoreDir(), 0755); err != nil {
		return err
	}
	return os.WriteFile(gitAuthConfigPath(), payload, 0600)
}

var kurloExePathOnce sync.Once
var kurloExePath string

func kurloExecutablePath() string {
	kurloExePathOnce.Do(func() {
		if exe, err := os.Executable(); err == nil {
			kurloExePath = exe
		}
	})
	return kurloExePath
}

func gitAuthGlobalArgs() []string {
	exe := kurloExecutablePath()
	if strings.TrimSpace(exe) == "" {
		return nil
	}

	helper := "!" + shellQuote(filepath.ToSlash(exe)) + " git-credential"
	return []string{"-c", "credential.helper=" + helper}
}

func gitAuthEnvVars(dir string) []string {
	cfg := loadWorkspaceAuth(strings.TrimSpace(dir))
	if cfg.Method == "ssh-key" {
		return gitSSHCommandEnv(cfg.SSHKeyPath)
	}
	return nil
}

func gitSSHCommandEnv(keyPath string) []string {
	key := strings.TrimSpace(keyPath)
	if key == "" {
		return nil
	}
	if info, err := os.Stat(key); err != nil || info.IsDir() {
		return nil
	}
	return []string{
		"GIT_SSH_COMMAND=ssh -i " + shellQuote(filepath.ToSlash(key)) +
			" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
	}
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func RunGitCredentialHelper(args []string) int {
	action := ""
	if len(args) > 0 {
		action = strings.TrimSpace(args[0])
	}
	fields := map[string]string{}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			break
		}
		if eq := strings.IndexByte(line, '='); eq > 0 {
			fields[line[:eq]] = line[eq+1:]
		}
	}
	host := fields["host"]
	switch action {
	case "get":
		cred, ok, err := gitCredentialLookupErr(host)
		if err != nil {
			fmt.Fprintf(os.Stderr, "kurlo: the saved Git token for %s could not be read (%v); save the token again in Kurlo\n", host, err)
			return 0
		}
		if !ok {

			return 0
		}
		user := strings.TrimSpace(cred.Username)
		if user == "" {
			user = strings.TrimSpace(fields["username"])
		}
		if user == "" {
			user = "x-access-token"
		}
		out := bufio.NewWriter(os.Stdout)
		fmt.Fprintf(out, "username=%s\n", user)
		fmt.Fprintf(out, "password=%s\n", cred.Token)
		_ = out.Flush()
		return 0
	case "erase":

		gitCredentialErase(host)
		return 0
	case "store":

		_, _ = io.Copy(io.Discard, os.Stdin)
		return 0
	default:
		return 0
	}
}
