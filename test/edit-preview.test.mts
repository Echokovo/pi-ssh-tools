import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	activateSsh,
	callContext,
	createWorkspace,
	FILES,
	invalidateCount,
	loadExtension,
	piTheme,
	resetWorkspace,
	rowRaw,
	rowText,
	runSshCommand,
	runTool,
	sshCallCount,
	useFakeRemoteHost,
} from "./support/harness.mts";

/**
 * The edit row shows its diff before the edit happens, which means reading the file off the host
 * while the model is still writing the call. That is the one preview in this extension that costs
 * a round trip, so these tests hold both halves: the diff has to arrive, and it must not be paid
 * for when it cannot be used - while the arguments are still streaming in, once the call has run,
 * or when there is no host to ask.
 */

const workspace = createWorkspace("pi-ssh-tools-preview-");
useFakeRemoteHost(workspace);

const extension = await loadExtension();
await activateSsh(extension, workspace);
const theme = await piTheme();

const edit = () => extension.tools.get("ssh_edit");
const ARGS = { path: "notes.txt", edits: [{ oldText: "beta", newText: "BETA" }] };

async function settle(): Promise<void> {
	// Long enough for one ssh call against the fake host to come back.
	await new Promise((resolve) => setTimeout(resolve, 150));
}

async function awaitPreview(state: Record<string, unknown>, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (previewOf(state) === undefined) {
		if (Date.now() > deadline) {
			throw new Error(`no preview after ${ms}ms: ${JSON.stringify(state)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function frame(component: any): string {
	return rowText(component).join("\n");
}

function paintsFrame(component: any): boolean {
	return rowRaw(component).some((line: string) => /\u001b\[48;2;\d+;\d+;\d+m/.test(line));
}

/** The preview lives on the row's own component, which is where the renderer keeps what it worked out. */
function previewOf(state: Record<string, unknown>): unknown {
	return (state.callComponent as { preview?: unknown } | undefined)?.preview;
}

test("the diff is on screen before the edit runs", async () => {
	resetWorkspace(workspace);
	const { context, state } = callContext({ args: ARGS });
	const before = sshCallCount(workspace);

	const first = edit().renderCall(ARGS, theme, context);
	await awaitPreview(state);
	// The preview asks for a repaint rather than building a second row, so the frame has to be
	// drawn again through the same component to see what it decided to show.
	const second = edit().renderCall(ARGS, theme, context);

	assert.equal(second, first, "the row was replaced instead of repainted");
	assert.match(frame(second), /BETA/, `the preview did not reach the row:\n${frame(second)}`);
	assert.equal(invalidateCount(state), 1, "the preview did not ask for exactly one repaint");
	assert.equal(sshCallCount(workspace) - before, 1, "the preview cost more than one round trip");
	assert.deepEqual(readFileSync(`${workspace.remote}/notes.txt`, "utf8"), FILES["notes.txt"], "the preview wrote to the file");
});

test("a path outside the remote working directory previews like any other", async () => {
	resetWorkspace(workspace);
	const args = { path: `${workspace.home}/notes.txt`, edits: [{ oldText: "beta", newText: "BETA" }] };
	const { context, state } = callContext({ args });

	edit().renderCall(args, theme, context);
	await awaitPreview(state);
	const shown = frame(edit().renderCall(args, theme, context));
	assert.match(shown, /BETA/, `the preview refused the path:\n${shown}`);
	assert.ok(!shown.includes("outside the active SSH working directory"), `the preview refused the path:\n${shown}`);

	// The row must not promise something the call itself then refuses.
	const result = await runTool(edit(), args, workspace.local);
	assert.equal(result.isError, false, `the row offered an edit the tool refused: ${JSON.stringify(result)}`);
	assert.ok(result.text?.includes(args.path), `the reply did not name the path it was given: ${result.text}`);
	assert.match(readFileSync(`${workspace.home}/notes.txt`, "utf8"), /BETA/);
});

test("no host is read while the arguments are still arriving", async () => {
	resetWorkspace(workspace);
	const { context, state } = callContext({ args: { path: "notes.txt" }, argsComplete: false });
	const before = sshCallCount(workspace);

	const component = edit().renderCall({ path: "notes.txt" }, theme, context);
	await settle();

	assert.equal(sshCallCount(workspace), before, "a half-written call already asked the host for the file");
	assert.equal(previewOf(state), undefined, "a half-written call already has a preview");
	assert.ok(paintsFrame(component), "a half-written call lost its frame");
});

test("no host is read again once the call has run", async () => {
	resetWorkspace(workspace);
	const { context, state } = callContext({ args: ARGS, executionStarted: true });
	const before = sshCallCount(workspace);

	const component = edit().renderCall(ARGS, theme, context);
	await settle();

	assert.equal(sshCallCount(workspace), before, "the row asked the host for the before image after the edit had already read it");
	assert.equal(previewOf(state), undefined, "a call that has run should not be showing a preview of its own file");
	assert.ok(paintsFrame(component), "a running call lost its frame");
});

test("nothing is read when there is no host", async () => {
	resetWorkspace(workspace);
	await runSshCommand(extension, workspace, "off");
	try {
		const { context, state } = callContext({ args: ARGS });
		const before = sshCallCount(workspace);

		const component = edit().renderCall(ARGS, theme, context);
		await settle();

		assert.equal(sshCallCount(workspace), before, "the row asked a host that is switched off for a file");
		assert.equal(previewOf(state), undefined, "a preview was computed with no host to compute it from");
		assert.ok(paintsFrame(component), `a row with no host lost its frame:\n${frame(component)}`);
	} finally {
		await activateSsh(extension, workspace);
	}
});

test("a preview that failed says so inside the frame", async () => {
	resetWorkspace(workspace);
	const args = { path: "gone.txt", edits: [{ oldText: "a", newText: "b" }] };
	const { context, state } = callContext({ args });

	edit().renderCall(args, theme, context);
	await awaitPreview(state);
	const component = edit().renderCall(args, theme, context);
	const shown = frame(component);

	assert.match(JSON.stringify(previewOf(state)), /error/, `a missing file did not come back as a failure: ${JSON.stringify(previewOf(state))}`);
	assert.match(shown, /gone\.txt|No such file|does not exist/, `the row gave no reason a reader could act on:\n${shown}`);
	assert.ok(paintsFrame(component), `a failed preview lost its frame:\n${shown}`);
});
