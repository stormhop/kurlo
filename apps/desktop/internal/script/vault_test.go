package script

import (
	"strings"
	"testing"
)

func TestPmVaultReadsLinkedVariables(t *testing.T) {
	t.Parallel()
	ctx := jsCtx()
	ctx.Environment["postman-api-key"] = "linked-value"
	result := runPre(t, ctx, `const apiKey = await pm.vault.get("postman-api-key");
pm.environment.set("copied", apiKey);
const missing = await pm.vault.get("nope");
pm.test("missing is undefined", () => pm.expect(missing).to.equal(undefined));`)
	if ctx.Environment["copied"] != "linked-value" {
		t.Fatalf("copied = %q, logs %v", ctx.Environment["copied"], result.Logs)
	}
	if len(result.Tests) != 1 || !result.Tests[0].Passed {
		t.Fatalf("tests = %+v", result.Tests)
	}
}

func TestPmVaultSetExplainsWhatToDo(t *testing.T) {
	t.Parallel()
	result := RunPreRequest(`await pm.vault.set("token", "x");`, jsCtx())
	if !strings.Contains(result.Error, "link the variable token to a secret manager") {
		t.Fatalf("error = %q", result.Error)
	}
	result = RunPreRequest(`pm.vault.unset("token").catch(e => pm.environment.set("caught", e.message));`, jsCtx())
	if result.Error != "" {
		t.Fatalf("error = %q", result.Error)
	}
}

func TestScriptsWithoutAwaitAreNotWrapped(t *testing.T) {
	t.Parallel()
	ctx := jsCtx()
	runPre(t, ctx, `var awaitCount = 1; tests["plain"] = awaitCount === 1;`)
	result := RunPreRequest(`function f() { return 1 } ; await`, jsCtx())
	if result.Error == "" {
		t.Fatal("a broken script ran")
	}
	if wrapTopLevelAwait(`async function x() { await 1 }`) != `async function x() { await 1 }` {
		t.Fatal("valid script with await inside a function was wrapped")
	}
}
