package script

import (
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestPostmanResponseBodyIsAString(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.Response = &model.HttpResponse{StatusCode: 200, Body: `{"id":7}`}
	res := jsTests(`pm.test("body compatibility", () => {
  pm.expect(typeof pm.response.body).to.equal("string");
  pm.expect(pm.response.body).to.equal(pm.response.text());
  pm.expect(JSON.parse(pm.response.body).id).to.equal(7);
});`, ctx)
	if res.Error != "" || len(res.Tests) != 1 || !res.Tests[0].Passed {
		t.Fatalf("Postman response body failed: %+v", res)
	}
}
