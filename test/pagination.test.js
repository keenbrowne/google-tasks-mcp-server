import assert from "node:assert/strict";
import { test } from "node:test";
import { CHARACTER_LIMIT } from "../dist/constants.js";
import { renderPage, tasksToMarkdown } from "../dist/format.js";
import { ResponseFormat } from "../dist/types.js";

for (const format of [ResponseFormat.MARKDOWN, ResponseFormat.JSON]) {
  test(`oversized final Google page can be followed without skipping tasks (${format})`, async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      title: `Task ${index}`,
      status: "needsAction",
      notes: "\\".repeat(2048) + "a".repeat(6144),
    }));
    const requests = [];

    const listTasks = (pageToken) => renderPage(
      4,
      async (pageSize) => {
        requests.push([pageToken, pageSize]);
        const start = Number(pageToken);
        const end = start + pageSize;
        return {
          items: tasks.slice(start, end),
          nextPageToken: end < tasks.length ? String(end) : undefined,
        };
      },
      format,
      "tasks",
      tasksToMarkdown
    );

    const first = await listTasks("2");
    assert.ok(first.content[0].text.length <= CHARACTER_LIMIT);
    assert.equal(first.structuredContent.has_more, true);
    assert.equal(first.structuredContent.next_page_token, "4");

    const last = await listTasks(first.structuredContent.next_page_token);
    assert.equal(last.structuredContent.has_more, false);
    assert.equal(last.structuredContent.next_page_token, undefined);
    assert.deepEqual(
      [...first.structuredContent.tasks, ...last.structuredContent.tasks],
      tasks.slice(2)
    );
    assert.deepEqual(requests, [["2", 4], ["2", 2], ["4", 4]]);
  });
}
