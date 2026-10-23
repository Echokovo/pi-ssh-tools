import assert from "node:assert/strict";
import test from "node:test";

import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

import { activateSsh, callContext, createWorkspace, lines, loadExtension, piTheme, rowRaw, rowText, textResult, toolRow, useFakeRemoteHost } from "./support/harness.mts";

/**
 * What a row looks like. The ssh tools borrow their layout from pi's own tools, so these compare
 * the two rows line by line - same background per line, same visible text - and cover the states
 * that a hand-written renderer gets wrong without anyone noticing: what a collapsed row keeps,
 * whether the content preview survives collapsing, and which colour each state paints.
 *
 * The row's first line is left out of the comparison on purpose. It names the tool and shows the
 * path as the model wrote it, next to the host, which is the one place the two are meant to
 * differ; the title has its own test below.
 */

const workspace = createWorkspace("pi-ssh-tools-render-");
useFakeRemoteHost(workspace);

const extension = await loadExtension();
await activateSsh(extension, workspace);
const theme = await piTheme();

const native = new Map<string, any>([
	["ssh_read", createReadToolDefinition(workspace.local)],
	["ssh_write", createWriteToolDefinition(workspace.local)],
	["ssh_edit", createEditToolDefinition(workspace.local)],
	["ssh_bash", createBashToolDefinition(workspace.local)],
]);

/** The row as a reader sees it, with the two things that are allowed to differ taken out. */
function visible(component: any): string[] {
	return rowText(component)
		.filter((line: string) => line.trim() !== "")
		.slice(1)
		.map((line: string) => line.replace(/\s*\[fakehost:[^\]]*\]/g, "").trimEnd());
}

function backgrounds(component: any): string[] {
	return rowRaw(component).map((line: string) => (line.match(/\u001b\[48;2;\d+;\d+;\d+m/g) ?? []).join(""));
}

async function rows(name: string, args: any, result: any, expanded: boolean) {
	const mine = await toolRow(extension.tools.get(name), args, result, workspace.local);
	const base = await toolRow(native.get(name), args, result, workspace.local);
	mine.setExpanded(expanded);
	base.setExpanded(expanded);
	return { mine, base };
}

async function assertSameRow(name: string, args: any, result: any, expanded: boolean) {
	const { mine, base } = await rows(name, args, result, expanded);
	assert.deepEqual(visible(mine), visible(base), `${name} at expanded=${expanded} does not read like pi's row:\n mine: ${JSON.stringify(visible(mine), null, 1)}\n  pi: ${JSON.stringify(visible(base), null, 1)}`);
	assert.deepEqual(backgrounds(mine), backgrounds(base), `${name} at expanded=${expanded} does not paint the same background as pi's row`);
}

test("a long read collapses to the same lines as pi's", async () => {
	const result = textResult(lines(200, "line"));
	await assertSameRow("ssh_read", { path: "notes.txt" }, result, false);
	await assertSameRow("ssh_read", { path: "notes.txt" }, result, true);
});

test("a write shows its content whether collapsed or not", async () => {
	const result = textResult("ok");
	await assertSameRow("ssh_write", { path: "main.ts", content: lines(200, "content") }, result, false);
	await assertSameRow("ssh_write", { path: "main.ts", content: lines(200, "content") }, result, true);
});

test("a write preview copes with the awkward contents", async () => {
	for (const content of [undefined, "", 42, "a\tb\nc"]) {
		const args = content === undefined ? { path: "notes.txt" } : { path: "notes.txt", content };
		const mine = extension.tools.get("ssh_write").renderCall(args, theme, callContext().context);
		const base = native.get("ssh_write").renderCall(args, theme, callContext().context);
		assert.deepEqual(rowText(mine).slice(1), rowText(base).slice(1), `content ${JSON.stringify(content)} renders differently from pi's`);
	}
});

test("bash output keeps the same tail when collapsed", async () => {
	const result = textResult(lines(200, "out"));
	await assertSameRow("ssh_bash", { command: "echo hi" }, result, false);
	await assertSameRow("ssh_bash", { command: "echo hi" }, result, true);
});

test("an edit shows its whole diff at either expansion", async () => {
	const details = {
		diff: " 1 alpha\n-2 beta\n+2 BETA\n 3 gamma",
		patch: "--- notes.txt\n+++ notes.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
		firstChangedLine: 2,
	};
	const result = { content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.txt." }], details, isError: false, timestamp: 0 };
	await assertSameRow("ssh_edit", { path: "notes.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, result, false);
	await assertSameRow("ssh_edit", { path: "notes.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, result, true);
});

test("a read title carries the line range the model asked for", async () => {
	for (const args of [{ path: "notes.txt" }, { path: "notes.txt", offset: 5 }, { path: "notes.txt", offset: 5, limit: 20 }, { path: "notes.txt", limit: 20 }]) {
		const mine = rowText(await toolRow(extension.tools.get("ssh_read"), args, textResult("x"), workspace.local)).join("\n");
		const base = rowText(await toolRow(native.get("ssh_read"), args, textResult("x"), workspace.local)).join("\n");
		const range = args.offset === undefined && args.limit === undefined ? "" : args.limit === undefined ? `:${args.offset}` : `:${args.offset ?? 1}-${(args.offset ?? 1) + args.limit - 1}`;
		assert.ok(mine.includes(`notes.txt${range}`), `ssh_read ${JSON.stringify(args)} lost its range:\n${mine}`);
		assert.ok(base.includes(`notes.txt${range}`), `pi's read ${JSON.stringify(args)} did not show that range either, so the test is wrong:\n${base}`);
	}
});

test("the edit frame is painted by state, not by luck", async () => {
	// The frame around an ssh_edit row is drawn by the extension, so the colours it uses for each
	// state have to be the ones pi uses, or the row stops matching every other row on screen.
	const args = { path: "notes.txt", edits: [{ oldText: "beta", newText: "BETA" }] };
	const states: Array<[string, any]> = [
		["still running", undefined],
		[
			"finished",
			{
				content: [{ type: "text", text: "ok" }],
				details: { diff: " 1 alpha\n-2 beta\n+2 BETA\n 3 gamma", patch: "", firstChangedLine: 2 },
				isError: false,
				timestamp: 0,
			},
		],
		["failed", { content: [{ type: "text", text: "boom" }], details: undefined, isError: true, timestamp: 0 }],
	];
	const painted = async (definition: any, result: any) => backgrounds(await toolRow(definition, args, result, workspace.local)).find((value: string) => value !== "") ?? "nothing";

	const ours: string[] = [];
	const theirs: string[] = [];
	for (const [, result] of states) {
		ours.push(await painted(extension.tools.get("ssh_edit"), result));
		theirs.push(await painted(native.get("ssh_edit"), result));
	}
	for (const [index, [label]] of states.entries()) {
		assert.equal(ours[index], theirs[index], `an edit ${label} wears ${ours[index]} here but pi paints ${theirs[index]}`);
	}
	assert.equal(new Set(ours).size, states.length, `the states are not told apart by colour: ${JSON.stringify(ours)}`);
});
