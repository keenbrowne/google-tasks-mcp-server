import type { McpServer } from "@modelcontextprotocol/server";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { BrowserContext, Page } from "playwright-core";

const fail = (message: string) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: message }],
});

export function registerRecurringTaskTool(server: McpServer): void {
  const profile = process.env.GOOGLE_TASKS_BROWSER_PROFILE;
  const executablePath = process.env.GOOGLE_TASKS_BROWSER_EXECUTABLE;
  const account = process.env.GOOGLE_TASKS_BROWSER_ACCOUNT;
  const taskList = process.env.GOOGLE_TASKS_BROWSER_TASKLIST;
  if (!profile || !executablePath || !account || !taskList) return;

  let busy = false;
  const withTasksPage = async (
    action: "save" | "update" | "delete",
    operation: (page: Page, state: { step: string; mutationAttempted: boolean }) => Promise<ReturnType<typeof fail> | { content: { type: "text"; text: string }[] }>,
  ) => {
    if (!isAbsolute(profile) || !isAbsolute(executablePath)) {
      return fail("Set the browser profile and browser executable to absolute paths.");
    }
    if (busy) return fail("Another recurring-task operation is running. Wait for that call to finish.");

    busy = true;
    let browser: BrowserContext | undefined;
    const state = { step: "load playwright-core", mutationAttempted: false };
    try {
      const { chromium } = await import("playwright-core");
      state.step = "launch Chromium using the dedicated profile. Close any browser already using that profile";
      browser = await chromium.launchPersistentContext(profile, {
        executablePath,
        headless: true,
        chromiumSandbox: true,
        locale: "en-US",
        timeout: 15_000,
      });
      browser.setDefaultTimeout(5_000);
      const page = browser.pages()[0] ?? await browser.newPage();
      state.step = "open Google Tasks";
      await page.goto("https://tasks.google.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      state.step = "verify the signed-in Google account in the dedicated Tasks profile";
      const accountControl = page.locator('[aria-label^="Google Account:"]');
      await accountControl.waitFor();
      const accountLabel = await accountControl.getAttribute("aria-label");
      if (new URL(page.url()).origin !== "https://tasks.google.com" ||
          !accountLabel?.toLowerCase().includes(`(${account.toLowerCase()})`)) {
        throw new Error("Unexpected account");
      }

      return await operation(page, state);
    } catch {
      return fail(state.mutationAttempted
        ? `The ${action} outcome is uncertain. Check Google Tasks before retrying.`
        : `Could not ${state.step}. The tool did not attempt to ${action} a task.`);
    } finally {
      try {
        await browser?.close();
      } catch {
        console.error("Could not close the recurring task browser. Close the dedicated browser profile before using it again.");
      } finally {
        busy = false;
      }
    }
  };

  async function findTask(page: Page, title: string, state: { step: string }, requireSeries: boolean) {
    state.step = "find the active task";
    await page.getByRole("button", { name: "Add a task", exact: true }).first().waitFor();
    const row = page.getByRole("listitem").filter({
      has: page.getByRole("button", { name: `Mark completed: ${title}`, exact: true }),
    });
    const matches = await row.count();
    if (matches === 0) return { error: fail("No visible active task has that exact title.") };
    if (matches > 1) return { error: fail("Multiple active tasks share this title. Give the intended series a unique title first.") };

    // The date button can use a relative label while the row uses a full date.
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const series = row.filter({
      has: page.getByLabel(new RegExp(`^${escapedTitle} with date .+, repeating$`, "s")),
    });
    const repeating = await series.count() === 1;
    if (requireSeries && !repeating) return { error: fail("Google Tasks does not identify this task as repeating.") };
    state.step = "verify the series belongs to the configured task list";
    await row.hover();
    await row.getByRole("button", { name: "Task options", exact: true }).click();
    const menu = page.getByRole("menu").filter({
      has: page.getByRole("menuitemcheckbox", { name: `Move to ${taskList}`, exact: true, checked: true }),
    });
    await menu.waitFor();
    return { row, menu, repeating };
  }

  server.registerTool(
    "google_tasks_create_recurring_task",
    {
      title: "Create Weekly Google Task",
      description: "Create a native Google Task that repeats every week with no end date. Uses the configured Google account and task list on tasks.google.com. If the save outcome is uncertain, check Google Tasks before retrying.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(1023),
        start_date: z.iso.date().describe("First all-day occurrence, YYYY-MM-DD"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ title, start_date }) => withTasksPage("save", async (page, state) => {
      const date = new Date(`${start_date}T00:00:00Z`);
      const format = (options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
      const inputDate = format({ month: "short", day: "numeric", year: "numeric" });
      const pickerDate = `${date.getUTCDate()} ${format({ month: "long" })} ${date.getUTCFullYear()}`;
      const scheduledDate = format({ dateStyle: "full" });
      const weekly = `Weekly on ${format({ weekday: "long" })}`;

      state.step = "open the Tasks editor";
      const row = page.getByRole("listitem").filter({
        has: page.getByRole("button", { name: `Mark completed: ${title}`, exact: true }),
      });
      await page.getByRole("button", { name: "Add a task", exact: true }).first().waitFor();
      if (await row.count()) {
        return fail("Google Tasks already shows an active task with this title. Check it before creating a series.");
      }
      await page.getByRole("button", { name: "Create", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "Add a task", exact: true });
      const combo = (name: string) => editor.getByRole("combobox", { name, exact: true });
      await editor.getByRole("textbox", { name: "Add title", exact: true }).fill(title);

      state.step = "select the configured Google Tasks list";
      const listControl = combo("Task list");
      await listControl.click();
      await editor.getByRole("option", { name: taskList, exact: true }).click();
      await listControl.getByText(taskList, { exact: true }).waitFor();

      state.step = "select and verify the first all-day occurrence";
      await editor.getByRole("checkbox", { name: "All day", exact: true }).check();
      const dateControl = combo("Set date");
      await dateControl.click();
      await dateControl.fill(inputDate);
      await dateControl.press("Enter");
      await dateControl.click();
      // Typing an unrecognized date can silently leave the old date selected.
      await editor.getByRole("button", { name: pickerDate, exact: true, pressed: true }).waitFor();
      await dateControl.press("Escape");

      state.step = "set the weekly recurrence";
      const recurrence = combo("Set recurrence");
      await recurrence.click();
      await editor.getByRole("option", { name: weekly, exact: true }).click();
      await recurrence.getByText(weekly, { exact: true }).waitFor();

      state.step = "save and verify the recurring task";
      state.mutationAttempted = true;
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await editor.waitFor({ state: "hidden" });
      const scheduled = row.getByRole("button", { name: `Scheduled for ${scheduledDate}`, exact: true });
      await scheduled.click();
      await page.getByText(weekly, { exact: true }).filter({ visible: true }).waitFor();
      return { content: [{ type: "text" as const, text: `Created weekly Google Task "${title}" starting ${start_date} in "${taskList}".` }] };
    }),
  );

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
  const units = { daily: "day", weekly: "week", monthly: "month", yearly: "year" } as const;
  server.registerTool(
    "google_tasks_update_recurring_task",
    {
      title: "Update Google Task Series",
      description: "Edit recurrence in place. Set convert_if_not_recurring to start repetition on a one-off task. Set frequency to none to stop future repeats and keep the active task. Google prevents re-enabling recurrence on that stopped task. Use the exact active task title. Weekdays replace the weekly day selection. Omitted interval keeps the existing multiplier.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(1023),
        frequency: z.enum(["daily", "weekly", "monthly", "yearly", "none"]).optional(),
        convert_if_not_recurring: z.boolean().optional().describe("Allow the existing one-off task to become recurring"),
        interval: z.number().int().min(1).max(99).optional().describe("Repeat every N days, weeks, months, or years"),
        weekdays: z.array(z.enum(days)).min(1).max(7).optional().describe("Days of the week on which to repeat"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ title, frequency, interval, weekdays, convert_if_not_recurring }) => {
      if (frequency === "none" && (interval || weekdays || convert_if_not_recurring)) return fail("Stopping recurrence cannot be combined with a schedule or conversion.");
      if (convert_if_not_recurring && !frequency && !weekdays) return fail("Specify a frequency or weekdays to start recurrence.");
      if (!frequency && !interval && !weekdays) return fail("Supply a frequency, interval, or weekdays.");
      if (weekdays && frequency && frequency !== "weekly") return fail("Weekdays require a weekly schedule.");
      if (weekdays && new Set(weekdays).size !== weekdays.length) return fail("Weekdays must be unique.");
      return withTasksPage("update", async (page, state) => {
        const target = await findTask(page, title, state, !convert_if_not_recurring && frequency !== "none");
        if (target.error) return target.error;
        const { row, menu } = target;
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });
        async function settleAndReload() {
          // Done closes the dialog inside an inline task editor. Leave that
          // editor and let its save finish before navigating away.
          await page.getByRole("heading", { name: taskList, exact: true }).click();
          // Tasks can keep background requests open. Network idle is only
          // a settling hint; the authoritative check is the reloaded rule.
          await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(error => {
            if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
          });
          // Verify a fresh page rather than the optimistic editor state.
          await page.reload({ waitUntil: "domcontentloaded" });
        }
        const editTask = () => row.getByRole("group", { name: "Task title", exact: true }).click();
        const ended = row.getByRole("button", { name: /^Ended repeating schedule:/ });
        if (frequency === "none") {
          await editTask();
          if (await ended.isVisible()) return { content: [{ type: "text", text: `The repeating schedule for "${title}" has already ended.` }] };
          if (!target.repeating && !await row.getByRole("button", { name: "Stop repeating", exact: true }).isVisible()) return { content: [{ type: "text", text: `"${title}" is already a one-off task.` }] };
          state.step = "open the stop-repeating control";
          const stop = row.getByRole("button", { name: "Stop repeating", exact: true });
          await stop.waitFor();
          await stop.press("Enter");
          const confirm = page.getByRole("dialog", { name: "Stop repeating this task", exact: true })
            .getByRole("button", { name: "Stop repeating", exact: true });
          await confirm.waitFor();
          state.mutationAttempted = true;
          await confirm.click();
          await confirm.waitFor({ state: "hidden" });
          await settleAndReload();
          const saved = await findTask(page, title, state, false);
          if (saved.error) throw new Error("Could not verify stopped task");
          await page.keyboard.press("Escape");
          await saved.menu.waitFor({ state: "hidden" });
          await editTask();
          await ended.waitFor();
          return { content: [{ type: "text", text: `Stopped recurrence and verified "${title}" remains an active task in "${taskList}".` }] };
        }
        const repeatSummary = row.getByRole("button", { name: /^(Daily|Weekly|Monthly|Annually|Yearly|Every|Weekdays)\b/i });
        state.step = "open the series recurrence settings";
        if (target.repeating) {
          await row.getByRole("button", { name: /^Scheduled for / }).click();
          if (await ended.isVisible()) return fail("This series has ended. Google requires a new task to start a new series.");
          await repeatSummary.click();
        } else {
          await editTask();
          const repeat = row.getByRole("button", { name: "Repeat", exact: true });
          if (!await repeat.isVisible() || !await repeat.isEnabled()) {
            return fail("Google Tasks does not offer Repeat for this task. A previously stopped series needs a new task to repeat again.");
          }
          await repeat.click();
        }
        const dialog = page.getByRole("dialog", { name: "Options to set or edit the task recurrence.", exact: true });
        // Monthly rules add more unnamed comboboxes below the interval unit.
        const unit = dialog.getByRole("combobox", { name: "", exact: true }).first();
        const multiplier = dialog.getByRole("spinbutton", { name: "Recurrence interval multiplier", exact: true });
        const dayButton = (day: typeof days[number]) => dialog.getByRole("button", { name: day, exact: true });
        const currentUnit = (await unit.innerText()).trim().replace(/s$/, "");
        const desiredUnit = frequency ? units[frequency] : weekdays ? "week" : currentUnit;
        const desiredInterval = interval ?? Number(await multiplier.inputValue());
        state.step = "set the requested recurrence rule";
        if (currentUnit !== desiredUnit) {
          await unit.click();
          await dialog.getByRole("option", { name: new RegExp(`^${desiredUnit}s?$`) }).click();
        }
        if (Number(await multiplier.inputValue()) !== desiredInterval) {
          await multiplier.fill(String(desiredInterval));
          await multiplier.press("Tab");
        }
        if (weekdays) {
          // Select the new days first so the rule always has at least one day.
          for (const day of [...weekdays, ...days.filter(day => !weekdays.includes(day))]) {
            const button = dayButton(day);
            if ((await button.getAttribute("aria-pressed") === "true") !== weekdays.includes(day)) await button.click();
          }
        }
        const verify = async () => {
          if ((await unit.innerText()).trim().replace(/s$/, "") !== desiredUnit ||
              Number(await multiplier.inputValue()) !== desiredInterval) throw new Error("Unexpected recurrence");
          if (weekdays) {
            for (const day of days) {
              await dialog.getByRole("button", { name: day, exact: true, pressed: weekdays.includes(day) }).waitFor();
            }
          }
        };
        await verify();
        state.mutationAttempted = true;
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await settleAndReload();
        await row.getByRole("button", { name: /^Scheduled for / }).click();
        await repeatSummary.click();
        await verify();
        const selectedDays = desiredUnit === "week"
          ? await dialog.getByRole("button", { pressed: true }).evaluateAll(buttons => buttons.map(b => b.getAttribute("aria-label")).join(", "))
          : "";
        return { content: [{ type: "text", text: `Verified "${title}" repeats every ${desiredInterval} ${desiredUnit}${desiredInterval === 1 ? "" : "s"}${selectedDays ? " on " + selectedDays : ""} in "${taskList}".` }] };
      });
    },
  );

  server.registerTool(
    "google_tasks_delete_recurring_task",
    {
      title: "Delete Google Task Series",
      description: "Delete all past and future occurrences of a repeating task in the configured Google Tasks list. Supply the exact title of the active occurrence. Use only when the user requests deletion of the entire series.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(1023),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ title }) => withTasksPage("delete", async (page, state) => {
      const target = await findTask(page, title, state, true);
      if (target.error) return target.error;
      const { row, menu } = target;
      state.step = "open the series deletion confirmation";
      await menu.getByRole("menuitem", { name: "Delete", exact: true }).press("Enter");
      const dialog = page.getByRole("dialog", { name: "Delete repeating task", exact: true });
      const deleteAll = dialog.getByRole("button", { name: "Delete all", exact: true });
      await deleteAll.waitFor();
      state.mutationAttempted = true;
      await deleteAll.click();
      await dialog.waitFor({ state: "hidden" });
      await row.waitFor({ state: "detached" });
      return { content: [{ type: "text", text: `Deleted all occurrences of "${title}" from "${taskList}".` }] };
    }),
  );
}
