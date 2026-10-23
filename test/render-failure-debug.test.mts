import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { activateSsh, callContext, createWorkspace, debugLogPath, hostile, loadExtension, piTheme, privateTmpDir, rowText, useFakeRemoteHost } from "./support/harness.mts";

/**
 * A frame that swallows its own failure is undiagnosable: the row looks merely wrong and nobody
 * knows which of its three parts - the arguments, the preview, the result - went bad. With
 * PI_SSH_TOOLS_DEBUG set, each one is written out with its stack. Without it, nothing is written,
 * which is what the other half of this pair of tests holds.
 */

// Has to be set before the extension is loaded: it decides where the extension logs, once, when
// its module is first evaluated.
process.env.PI_SSH_TOOLS_DEBUG = "1";

const workspace = createWorkspace("pi-ssh-tools-debug-");
useFakeRemoteHost(workspace);

// A log directory of our own: the file the extension writes has the same name every time, and the
// test that turns debugging off is checking in another process that no such file appears.
privateTmpDir("pi-ssh-tools-log-");

const extension = await loadExtension();
await activateSsh(extension, workspace);
const theme = await piTheme();

const edit = () => extension.tools.get("ssh_edit");
const marker = `pi-ssh-tools-debug-${process.pid}`;

test("a failed render is written down with the stack that produced it", () => {
	const { context } = callContext();

	edit().renderCall(hostile(`${marker}-call`), theme, context);
	edit().renderResult(hostile(`${marker}-result`), { expanded: false }, theme, context);

	const log = readFileSync(debugLogPath(), "utf8");
	assert.match(log, new RegExp(`renderCall: .*${marker}-call`), "a failed call render was not logged where it could be read");
	assert.match(log, new RegExp(`renderResult: .*${marker}-result`), "a failed result render was not logged where it could be read");
	// Without the stack the log names the symptom but not the line that caused it.
	assert.match(log, new RegExp(`${marker}-call[\\s\\S]{0,4000}?\\n\\s+at `), "the log has no stack for the failed call render");
});

test("the row still shows the reason on screen while debugging", () => {
	const { context } = callContext();
	const component = edit().renderCall(hostile(`${marker}-visible`), theme, context);

	assert.match(rowText(component).join("\n"), new RegExp(`${marker}-visible`), "logging replaced the message the reader sees");
});
