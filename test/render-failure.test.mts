import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { activateSsh, callContext, createWorkspace, debugLogPath, hostile, loadExtension, piTheme, privateTmpDir, rowRaw, rowText, useFakeRemoteHost } from "./support/harness.mts";

/**
 * The edit row draws its own frame, which is what lets it show a diff inside the frame. The price
 * is that there is nothing left to draw the frame if the renderer throws: pi falls back to a bare
 * line of text and the row loses its colour, its indentation, and its shape. So the renderer has
 * to fail without throwing, and say what failed while it is at it.
 */

// Has to be set before the extension is loaded: it decides where the extension logs, once, when
// its module is first evaluated.
delete process.env.PI_SSH_TOOLS_DEBUG;

const workspace = createWorkspace("pi-ssh-tools-failure-");
useFakeRemoteHost(workspace);

// A log directory of our own: the file the extension would write has the same name every time,
// and the test that turns debugging on is running in another process at the same moment.
privateTmpDir("pi-ssh-tools-log-");

const extension = await loadExtension();
await activateSsh(extension, workspace);
const theme = await piTheme();

const edit = () => extension.tools.get("ssh_edit");
const CALL_MARKER = `pi-ssh-tools-failure-call-${process.pid}`;
const RESULT_MARKER = `pi-ssh-tools-failure-result-${process.pid}`;
const ERROR_BG = theme.bg("toolErrorBg", "x").split("x")[0];

test("a failing call renderer still draws a frame", () => {
	const { context } = callContext();
	const component = edit().renderCall(hostile(CALL_MARKER), theme, context);
	const shown = rowText(component).join("\n");

	assert.ok(rowRaw(component).join("\n").includes(ERROR_BG), `a failed render left no frame:\n${shown}`);
	assert.match(shown, /ssh_edit/, `a failed render forgot to say which tool it was:\n${shown}`);
	assert.match(shown, new RegExp(CALL_MARKER), `a failed render gave no reason:\n${shown}`);
});

test("a failing result renderer still says what failed", () => {
	const { context } = callContext();
	const container = edit().renderResult(hostile(RESULT_MARKER), { expanded: false }, theme, context);
	const shown = rowText(container).join("\n");

	assert.match(shown, new RegExp(RESULT_MARKER), `a failed result gave no reason:\n${shown}`);
});

test("nothing is written to disk about it", () => {
	assert.equal(existsSync(debugLogPath()), false, `${debugLogPath()} was written with PI_SSH_TOOLS_DEBUG unset`);
});
