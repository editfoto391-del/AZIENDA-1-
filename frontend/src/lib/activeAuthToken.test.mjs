import assert from "node:assert/strict";
import test from "node:test";
import { activeAuthToken } from "./activeAuthToken.mjs";

function storage(values = {}) {
  return {
    getItem: (key) => values[key] || null,
  };
}

test("worker access uses a tab-scoped session without replacing the company profile token", () => {
  const companyToken = "company-profile-token";
  const workerToken = "worker-session-token";

  assert.equal(activeAuthToken(
    storage({ token: companyToken }),
    storage({
      "erp-worker-access-session": "true",
      "erp-worker-session-token": workerToken,
    }),
  ), workerToken);
  assert.equal(activeAuthToken(storage({ token: companyToken }), storage({})), companyToken);
});
