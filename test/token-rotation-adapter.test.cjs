const assert = require("node:assert/strict");
const test = require("node:test");

const { manageTokenRotation } = require("../scripts/token-rotation.cjs");

const config = Object.freeze({
  centralTokenExpiresOn: "2027-03-03",
  pilotCompleted: true,
  quotaReview: null,
  scheduleMode: "weekly",
  schemaVersion: 1,
});

test("creates the rotation issue at thirty days and skips safely before expiry is recorded", async () => {
  let calls = [];
  const request = async (url, options = {}) => {
    calls.push({ options, url });
    return options.method === "POST"
      ? { body: { number: 9 }, status: 201 }
      : { body: [], status: 200 };
  };

  assert.deepEqual(
    await manageTokenRotation({
      config: { ...config, centralTokenExpiresOn: null },
      repository: "renanfranca/seed4j-main-snapshots",
      request,
      today: "2027-02-01",
    }),
    { action: "none", reason: "expiry-not-recorded" },
  );
  assert.equal(calls.length, 0);

  const result = await manageTokenRotation({
    config,
    repository: "renanfranca/seed4j-main-snapshots",
    request,
    today: "2027-02-01",
  });

  assert.deepEqual(result, { action: "create", issueNumber: 9 });
  assert.match(calls[0].url, /labels=publisher-token-rotation/);
  assert.equal(calls[1].options.method, "POST");
  assert.match(calls[1].options.body.body, /@renanfranca/);
});
