import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { registerRecurringTaskTool } from "../dist/tools/recurringTasks.js";

test("weekly recurrence is opt-in and validates inputs before opening a browser", { timeout: 10000 }, async (t) => {
  const config = {
    GOOGLE_TASKS_BROWSER_ACCOUNT: "fixture@example.com",
    GOOGLE_TASKS_BROWSER_EXECUTABLE: "relative-chromium",
    GOOGLE_TASKS_BROWSER_PROFILE: "relative-profile",
    GOOGLE_TASKS_BROWSER_TASKLIST: "My Tasks",
  };
  const originals = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of Object.keys(config)) delete process.env[key];
  const registerTool = t.mock.fn();
  registerRecurringTaskTool({ registerTool });
  assert.equal(registerTool.mock.callCount(), 0);

  Object.assign(process.env, config);

  const server = new McpServer({ name: "google-tasks-test-server", version: "1" });
  registerRecurringTaskTool(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "google-tasks-test", version: "1" }, {
    versionNegotiation: { mode: "legacy" },
  });
  await server.connect(serverTransport);

  try {
    await client.connect(clientTransport);
    const name = "google_tasks_create_recurring_task";
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    assert.equal(tool.annotations.idempotentHint, false);

    const updateName = "google_tasks_update_recurring_task";
    assert.ok(tools.some((item) => item.name === updateName));
    for (const [fields, message] of [
      [{}, /supply a frequency/i],
      [{ convert_if_not_recurring: true, interval: 2 }, /specify a frequency/i],
      [{ convert_if_not_recurring: true, frequency: "weekly" }, /absolute paths/i],
      [{ frequency: "none" }, /absolute paths/i],
      [{ frequency: "none", interval: 2 }, /stopping recurrence/i],
      [{ frequency: "none", convert_if_not_recurring: true }, /stopping recurrence/i],
      [{ interval: 100 }, /interval/i],
      [{ frequency: "daily", weekdays: ["Monday"] }, /weekly schedule/i],
      [{ weekdays: ["Friday", "Friday"] }, /unique/i],
      [{ weekdays: ["Friday"] }, /absolute paths/i],
    ]) {
      const result = await client.callTool({ name: updateName, arguments: { title: "Test series", ...fields } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, message);
    }

    const deleteName = "google_tasks_delete_recurring_task";
    assert.equal(tools.find((item) => item.name === deleteName)?.annotations.destructiveHint, true);
    const emptyTitle = await client.callTool({ name: deleteName, arguments: { title: "  " } });
    assert.equal(emptyTitle.isError, true);
    const invalidDeleteConfig = await client.callTool({ name: deleteName, arguments: { title: "Test series" } });
    assert.match(invalidDeleteConfig.content[0].text, /absolute paths/i);

    const invalidDate = await client.callTool({
      name, arguments: { title: "Review budget", start_date: "2026-02-30" },
    });
    assert.equal(invalidDate.isError, true);
    assert.match(invalidDate.content[0].text, /input validation.*start_date/is);

    const invalidConfig = await client.callTool({
      name, arguments: { title: "Review budget", start_date: "2026-12-07" },
    });
    assert.equal(invalidConfig.isError, true);
    assert.match(invalidConfig.content[0].text, /absolute paths/i);
  } finally {
    await client.close();
    await server.close();
  }
});
