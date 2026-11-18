package api

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const docsCLIUsage = "Usage: kurlo docs build [collection name or ID] [--workspace DIR] [--out FILE_OR_DIR] [--docs-base-url URL] [--open]"

func docsCollection(collections []cliCollection, selector string) (cliCollection, error) {
	if len(collections) == 0 {
		return cliCollection{}, fmt.Errorf("no collections in this workspace")
	}
	if selector == "" && len(collections) == 1 {
		return collections[0], nil
	}
	var matches []cliCollection
	var names []string
	for _, col := range collections {
		if col.ID == selector {
			return col, nil
		}
		if col.Name == selector {
			matches = append(matches, col)
		}
		names = append(names, fmt.Sprintf("%s (%s)", col.Name, col.ID))
	}
	switch {
	case len(matches) == 1:
		return matches[0], nil
	case len(matches) > 1:
		return cliCollection{}, fmt.Errorf("multiple collections named %q; choose by ID: %s", selector, strings.Join(names, ", "))
	case selector == "":
		return cliCollection{}, fmt.Errorf("choose a collection: %s", strings.Join(names, ", "))
	default:
		return cliCollection{}, fmt.Errorf("collection %q not found; available: %s", selector, strings.Join(names, ", "))
	}
}

func RunDocsCLI(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprintln(stdout, docsCLIUsage)
		return 0
	}
	if args[0] != "build" {
		fmt.Fprintln(stderr, docsCLIUsage)
		return 2
	}
	fs := flag.NewFlagSet("kurlo docs build", flag.ContinueOnError)
	fs.SetOutput(stderr)
	root := fs.String("workspace", ".", "Kurlo YAML workspace directory")
	out := fs.String("out", "kurlo-docs", "HTML file or output directory for index.html")
	linkBase := fs.String("docs-base-url", "", "website URL for relative links in documentation")
	open := fs.Bool("open", false, "open the generated site in your browser")
	selector := fs.String("collection", "", "collection name or ID")
	fs.Usage = func() { fmt.Fprintln(stderr, docsCLIUsage); fs.PrintDefaults() }
	args = args[1:]
	var positional []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			if err == flag.ErrHelp {
				return 0
			}
			return 2
		}
		args = fs.Args()
		if len(args) > 0 {
			positional = append(positional, args[0])
			args = args[1:]
		}
	}
	if len(positional) > 1 || (len(positional) == 1 && *selector != "") {
		fmt.Fprintln(stderr, "kurlo docs build: specify one collection")
		return 2
	}
	if len(positional) == 1 {
		*selector = positional[0]
	}
	path, err := buildWorkspaceDocs(*root, *selector, *out, *linkBase)
	if err == nil {
		fmt.Fprintln(stdout, path)
		if *open {
			err = openCollectionDocs(path)
		}
	}
	if err != nil {
		fmt.Fprintln(stderr, "kurlo docs build:", err)
		return 2
	}
	return 0
}

func buildWorkspaceDocs(root, selector, out, linkBase string) (string, error) {
	base, err := docsLinkBase(linkBase)
	if err != nil {
		return "", err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", err
	}
	_, collections, requests, environments, err := loadCLIWorkspace(root)
	if err != nil {
		return "", err
	}
	collection, err := docsCollection(collections, selector)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(out) == "" {
		return "", fmt.Errorf("choose an output file or directory")
	}
	info, err := os.Stat(out)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if !docsHTMLPath(out) || info != nil && info.IsDir() || strings.HasSuffix(out, string(filepath.Separator)) {
		out = filepath.Join(out, "index.html")
	}
	page := collectionDocsPage(collection, requests, environments, nil)
	page.LinkBase = base
	return writeCollectionDocs(out, page, 0600)
}
