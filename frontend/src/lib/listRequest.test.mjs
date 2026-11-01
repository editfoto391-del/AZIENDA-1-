import assert from "node:assert/strict";
import test from "node:test";
import { listViewState, loadListRequest } from "./listRequest.mjs";

function stateSetter(initial) {
  let state = initial;
  return {
    get: () => state,
    set: (next) => {
      state = typeof next === "function" ? next(state) : next;
    },
  };
}

for (const workflow of ["Stock Movement Ledger", "Assistant Conversations"]) {
  test(`${workflow} shows request errors and retry recovers`, async () => {
    const state = stateSetter({ items: [], loading: true, error: "" });
    let attempts = 0;
    const request = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Temporary API failure");
      return [{ id: `${workflow}-record` }];
    };
    const load = () => loadListRequest({
      request,
      setState: state.set,
      errorMessage: (error) => error.message,
    });

    assert.equal(listViewState(state.get()), "loading");
    assert.equal(await load(), false);
    assert.equal(state.get().error, "Temporary API failure");
    assert.equal(listViewState(state.get()), "error");
    assert.equal(await load(), true);
    assert.equal(state.get().error, "");
    assert.equal(state.get().items.length, 1);
    assert.equal(listViewState(state.get()), "items");
  });
}

test("a successful empty response is distinct from a failed response", async () => {
  const state = stateSetter({ items: [], loading: true, error: "" });
  const loaded = await loadListRequest({
    request: async () => [],
    setState: state.set,
    errorMessage: (error) => error.message,
  });

  assert.equal(loaded, true);
  assert.equal(state.get().error, "");
  assert.equal(listViewState(state.get()), "empty");
});

test("failed refresh does not replace existing rows with an empty state", async () => {
  const state = stateSetter({ items: [{ id: "existing" }], loading: false, error: "" });
  await loadListRequest({
    request: async () => { throw new Error("offline"); },
    setState: state.set,
    errorMessage: (error) => error.message,
  });

  assert.equal(state.get().items.length, 1);
  assert.equal(listViewState(state.get()), "error");
});
