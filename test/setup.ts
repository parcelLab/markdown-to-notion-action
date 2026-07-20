import assert from "node:assert/strict";
import { afterEach } from "node:test";

import nock from "nock";

nock.disableNetConnect();

afterEach(() => {
  const pendingMocks = nock.pendingMocks();
  nock.cleanAll();
  assert.deepEqual(pendingMocks, []);
});
