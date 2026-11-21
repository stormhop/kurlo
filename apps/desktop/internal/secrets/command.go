package secrets

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
)

type commandProvider struct {
	config ProviderConfig
	env    Environment
}

func (p *commandProvider) binary() (string, error) {
	name := p.config.Command[0]
	if strings.HasPrefix(name, "~") {
		expanded, err := expandHome(name, p.env)
		if err != nil {
			return "", newError(KindToolMissing, p.config.ID, "cannot find %s: %v", name, err)
		}
		name = expanded
	}
	if filepath.IsAbs(name) || strings.ContainsAny(name, `/\`) {
		path, err := p.env.LookPath(name)
		if err != nil {
			return "", newError(KindToolMissing, p.config.ID, "%s is not an executable file", name)
		}
		return path, nil
	}
	path, err := p.env.LookPath(name)
	if err != nil {
		return "", newError(KindToolMissing, p.config.ID, "%s is not installed or not in PATH", name)
	}
	return path, nil
}

func CommandArgs(command []string, path, version string) []string {
	if len(command) == 0 {
		return nil
	}
	args := make([]string, 0, len(command))
	placed := false
	for _, arg := range command[1:] {
		if strings.Contains(arg, "{path}") {
			placed = true
		}
		args = append(args, strings.NewReplacer("{path}", path, "{version}", version).Replace(arg))
	}
	if !placed {
		args = append(args, path)
	}
	return args
}

func (p *commandProvider) Fetch(ctx context.Context, path, version string) (Secret, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return Secret{}, newError(KindInvalidRef, p.config.ID, "path is empty")
	}
	if strings.HasPrefix(path, "-") {
		return Secret{}, newError(KindInvalidRef, p.config.ID, "a path cannot start with -")
	}
	binary, err := p.binary()
	if err != nil {
		return Secret{}, err
	}
	stdout, stderr, err := p.env.Run(ctx, binary, CommandArgs(p.config.Command, path, version), nil)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Secret{}, newError(KindTimeout, p.config.ID, "%s did not finish before the timeout", filepath.Base(binary))
		}
		return Secret{}, newError(KindUnavailable, p.config.ID, "%s failed: %s", filepath.Base(binary), toolMessage(stderr, err))
	}
	return Secret{Raw: strings.TrimRight(string(stdout), "\r\n")}, nil
}

func (p *commandProvider) Check(context.Context) (Status, error) {
	binary, err := p.binary()
	if err != nil {
		return Status{}, err
	}
	return Status{Detail: "Runs " + strings.Join(append([]string{binary}, p.config.Command[1:]...), " ")}, nil
}
