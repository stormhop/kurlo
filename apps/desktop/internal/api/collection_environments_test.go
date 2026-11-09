package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"gopkg.in/yaml.v3"
)

func TestKurloStorePersistsCollectionPinnedEnvironments(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	payload := `{
  "version": 2,
  "activeWorkspaceId": "workspace-main",
  "workspaces": [{"id":"workspace-main","name":"Main","filesystemName":"Main","createdAt":1,"updatedAt":1}],
  "collections": [{
    "id":"collection-payment",
    "workspaceId":"workspace-main",
    "name":"Payment API",
    "filesystemName":"Payment-API",
    "description":"",
    "collapsed":false,
    "folderPaths":[],
    "environmentIds":["env-payment-dev","env-payment-staging"],
    "defaultEnvironmentId":"env-payment-staging",
    "defaults":{},
    "createdAt":1,
    "updatedAt":1
  }],
  "requests": [],
  "environments": [
    {"id":"env-payment-dev","workspaceId":"workspace-main","name":"Payment Dev","filesystemName":"Payment-Dev","values":[]},
    {"id":"env-payment-staging","workspaceId":"workspace-main","name":"Payment Staging","filesystemName":"Payment-Staging","values":[]}
  ]
}`

	if err := saveKurloStorePayload(localPath, workspaceRoot, payload); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}

	collectionPath := filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Payment-API", "collection.yml")
	collectionText, err := os.ReadFile(collectionPath)
	if err != nil {
		t.Fatalf("read collection.yml: %v", err)
	}
	for _, expected := range []string{"environmentIds:", "- env-payment-dev", "- env-payment-staging", "defaultEnvironmentId: env-payment-staging"} {
		if !strings.Contains(string(collectionText), expected) {
			t.Fatalf("collection.yml is missing %q:\n%s", expected, collectionText)
		}
	}
	var document any
	if err := yaml.Unmarshal(collectionText, &document); err != nil {
		t.Fatalf("parse collection.yml: %v", err)
	}
	asJSON, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(asJSON))
	if err != nil {
		t.Fatal(err)
	}
	if err := compileWorkspaceSchemaForTest(t).Validate(instance); err != nil {
		t.Fatalf("collection.yml does not match the workspace schema: %v", err)
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load kurlo store: %v", err)
	}
	for _, expected := range []string{`"environmentIds": [`, `"env-payment-dev"`, `"defaultEnvironmentId": "env-payment-staging"`} {
		if !strings.Contains(loaded, expected) {
			t.Fatalf("loaded payload lost %q:\n%s", expected, loaded)
		}
	}
}
