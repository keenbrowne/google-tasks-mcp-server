import assert from "node:assert/strict";
import { test } from "node:test";
import { GaxiosError } from "gaxios";
import { describeApiError } from "../dist/services/tasksClient.js";

const cases = [
  ["revoked OAuth refresh token", 400, { error: "invalid_grant" }, /authorization has expired or was revoked.*Re-authorize/],
  ["expired credentials", 401, {}, /rejected the credentials.*Re-authorize/],
  ["missing permissions", 403, { error: { message: "Insufficient scope" } }, /Permission denied.*Insufficient scope/],
  ["missing task or list", 404, { error: { message: "Not Found" } }, /Not found \(404\).*Double check the ID/],
  ["rate limit", 429, {}, /Rate limit exceeded \(429\).*before retrying/],
  ["upstream outage", 503, {}, /Google Tasks API is having issues \(503\).*Try again/],
];

for (const [label, status, data, expected] of cases) {
  test(`Google API error gives actionable guidance for ${label}`, () => {
    const error = new GaxiosError("Request failed", { responseType: "json" }, {
      status,
      data,
      bodyUsed: true,
    });
    assert.match(describeApiError(error), expected);
  });
}
