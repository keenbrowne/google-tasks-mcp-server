import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const protocols = [
  ["legacy", "legacy"],
  ["2026-07-28", { pin: "2026-07-28" }],
];

for (const [label, mode] of protocols) {
  test(`stdio advertises its tools and rejects invalid inputs (${label})`, { timeout: 10000 }, async () => {
    // Startup checks file existence. Invalid fixture credentials keep this test offline.
    const fixture = fileURLToPath(new URL("../package.json", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      env: { GOOGLE_TASKS_CLIENT_SECRET: fixture, GOOGLE_TASKS_TOKEN_PATH: fixture },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "google-tasks-test", version: "1" },
      { versionNegotiation: { mode } }
    );

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(({ name }) => name).sort(), [
        "google_tasks_clear_completed_tasks",
        "google_tasks_complete_task",
        "google_tasks_create_task",
        "google_tasks_create_tasklist",
        "google_tasks_delete_task",
        "google_tasks_delete_tasklist",
        "google_tasks_get_task",
        "google_tasks_get_tasklist",
        "google_tasks_list_tasklists",
        "google_tasks_list_tasks",
        "google_tasks_move_task",
        "google_tasks_reopen_task",
        "google_tasks_update_task",
        "google_tasks_update_tasklist",
      ]);

      const list = tools.find(({ name }) => name === "google_tasks_list_tasks");
      assert.equal(list.annotations.readOnlyHint, true);
      assert.equal(list.inputSchema.properties.tasklist_id.default, "@default");
      const deletion = tools.find(({ name }) => name === "google_tasks_delete_task");
      assert.equal(deletion.annotations.destructiveHint, true);
      assert.ok(deletion.inputSchema.required.includes("task_id"));

      const invalidLimit = await client.callTool({ name: list.name, arguments: { limit: 101 } });
      assert.equal(invalidLimit.isError, true);
      assert.match(invalidLimit.content[0].text, /input validation.*limit/is);

      const emptyUpdate = await client.callTool({
        name: "google_tasks_update_task",
        arguments: { task_id: "fixture" },
      });
      assert.equal(emptyUpdate.isError, true);
      assert.match(emptyUpdate.content[0].text, /Provide at least one field to update/);
    } finally {
      await client.close();
    }
  });
}
