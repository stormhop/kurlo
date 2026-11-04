package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const mcpChangeMaxFileBytes = 512 * 1024

type mcpReviewFunc func(changes []model.AgentFileChange) error

type mcpReviewKey struct{}

type mcpCallRecord struct {
	changes []model.AgentFileChange
	commit  string
	branch  string
}

type mcpCallRecordKey struct{}

func withMcpReview(ctx context.Context, review mcpReviewFunc) context.Context {
	return context.WithValue(ctx, mcpReviewKey{}, review)
}

func mcpReviewFrom(ctx context.Context) mcpReviewFunc {
	review, _ := ctx.Value(mcpReviewKey{}).(mcpReviewFunc)
	return review
}

func mcpRecordFrom(ctx context.Context) *mcpCallRecord {
	record, _ := ctx.Value(mcpCallRecordKey{}).(*mcpCallRecord)
	return record
}

func readWorkspaceFileContents(root string) (map[string][]byte, error) {
	snapshot, err := scanWorkspaceFiles(root, nil, false)
	if err != nil {
		return nil, err
	}
	files := make(map[string][]byte, len(snapshot))
	for rel := range snapshot {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		files[rel] = data
	}
	return files, nil
}

func diffWorkspaceFiles(before, after map[string][]byte) []model.AgentFileChange {
	paths := map[string]bool{}
	for rel := range before {
		paths[rel] = true
	}
	for rel := range after {
		paths[rel] = true
	}
	sorted := make([]string, 0, len(paths))
	for rel := range paths {
		old, hadOld := before[rel]
		next, hasNext := after[rel]
		if hadOld == hasNext && bytes.Equal(old, next) {
			continue
		}
		sorted = append(sorted, rel)
	}
	sort.Strings(sorted)
	changes := make([]model.AgentFileChange, 0, len(sorted))
	for _, rel := range sorted {
		change := model.AgentFileChange{Path: rel}
		old, hadOld := before[rel]
		next, hasNext := after[rel]
		if len(old) > mcpChangeMaxFileBytes || len(next) > mcpChangeMaxFileBytes {
			change.TooLarge = true
		} else {
			if hadOld {
				text := string(old)
				change.Before = &text
			}
			if hasNext {
				text := string(next)
				change.After = &text
			}
		}
		changes = append(changes, change)
	}
	return changes
}

func stageMCPStore(st *mcpStore, before map[string][]byte) (map[string][]byte, error) {
	dir, err := os.MkdirTemp("", "kurlo-agent-stage-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	for rel, data := range before {
		target := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return nil, err
		}
	}
	root := st.root
	st.root = dir
	err = st.save()
	st.root = root
	if err != nil {
		return nil, err
	}
	return readWorkspaceFileContents(dir)
}

func applyWorkspaceFiles(root string, before, after map[string][]byte) error {
	current, err := readWorkspaceFileContents(root)
	if err != nil {
		return err
	}
	changed := diffWorkspaceFiles(before, after)
	for _, change := range changed {
		old, hadOld := before[change.Path]
		now, hasNow := current[change.Path]
		if hadOld != hasNow || !bytes.Equal(old, now) {
			return fmt.Errorf("%s changed while waiting for approval, so nothing was written; try again", change.Path)
		}
	}
	for i, change := range changed {
		if err := writeMCPWorkspaceFile(root, change.Path, after); err != nil {
			for _, applied := range changed[:i+1] {
				err = errors.Join(err, writeMCPWorkspaceFile(root, applied.Path, before))
			}
			return err
		}
	}
	for _, change := range changed {
		if _, keep := after[change.Path]; !keep {
			removeEmptyWorkspaceDirs(root, filepath.Dir(filepath.Join(root, filepath.FromSlash(change.Path))))
		}
	}
	return nil
}

func writeMCPWorkspaceFile(root, rel string, files map[string][]byte) error {
	parts := strings.Split(rel, "/")
	for _, part := range parts {
		if part == "." || part == ".." || part == "" {
			return fmt.Errorf("invalid workspace file path: %s", rel)
		}
	}
	target := filepath.Join(root, filepath.FromSlash(rel))
	data, keep := files[rel]
	if _, err := ensureManagedWorkspaceDir(root, parts[:len(parts)-1]...); err != nil {
		return err
	}
	info, err := os.Lstat(target)
	if err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to replace a non-regular workspace file: %s", rel)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if keep {
		return writeTextFileAtomic(target, data)
	}
	if err == nil {
		return os.Remove(target)
	}
	return nil
}

func removeEmptyWorkspaceDirs(root, dir string) {
	stop := filepath.Join(root, fileStoreWorkspacesDir)
	for {
		rel, err := filepath.Rel(stop, dir)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			return
		}
		if os.Remove(dir) != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}

func (s *mcpServer) mutate(ctx context.Context, change func(st *mcpStore) (func() any, error)) (any, error) {
	root := s.opts.workspace
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return nil, err
	}
	defer func() {
		if unlock != nil {
			unlock()
		}
	}()
	st, err := s.loadStore()
	if err != nil {
		return nil, err
	}
	result, err := change(st)
	if err != nil {
		return nil, err
	}
	before, err := readWorkspaceFileContents(root)
	if err != nil {
		return nil, err
	}
	var after map[string][]byte
	profileChanges := st.globals.change()
	if review := mcpReviewFrom(ctx); review != nil || st.batch {
		staged, err := stageMCPStore(st, before)
		if err != nil {
			return nil, err
		}
		changes := append(diffWorkspaceFiles(before, staged), profileChanges...)
		if review != nil && len(changes) > 0 {
			unlock()
			unlock = nil
			if err := review(changes); err != nil {
				return nil, err
			}
			if unlock, err = lockWorkspaceWrites(root); err != nil {
				return nil, err
			}
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var beforeProfile, profile string
		if len(profileChanges) > 0 {
			beforeProfile, profile, err = st.globals.updatedProfile(root)
			if err != nil {
				return nil, err
			}
		}
		if err := applyWorkspaceFiles(root, before, staged); err != nil {
			return nil, err
		}
		if profile != "" {
			if err := saveRequestStorePayload(requestStorePath(), profile); err != nil {
				if currentProfileGlobalsRevision() == profileGlobalsRevision(profile) {
					err = errors.Join(err, saveRequestStorePayload(requestStorePath(), beforeProfile))
				}
				return nil, errors.Join(err, applyWorkspaceFiles(root, staged, before))
			}
		}
		after = staged
	} else {
		if err := st.save(); err != nil {
			return nil, err
		}
		if after, err = readWorkspaceFileContents(root); err != nil {
			return nil, err
		}
	}
	written := diffWorkspaceFiles(before, after)
	if record := mcpRecordFrom(ctx); record != nil {
		record.changes = append(record.changes, written...)
	}
	if s.onWrite != nil && len(written) > 0 {
		s.onWrite(root, written)
	}
	return result(), nil
}
