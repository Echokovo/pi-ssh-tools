import assert from "node:assert/strict";
import test from "node:test";

import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

import { activateSsh, createWorkspace, loadExtension, useFakeRemoteHost } from "./support/harness.mts";

/**
 * A tool description is what the model reads before it decides how to use the tool, so an ssh tool
 * inherits pi's wording and only says what pi cannot: which host it works on, and where a relative
 * path lands. This caught a real regression - the ssh edit description had quietly lost pi's
 * sentences about how to write an edit, and the model stopped following them - and it will catch
 * the opposite mistake too, which is pi changing its rules and this extension going on quoting the
 * old ones.
 */

const workspace = createWorkspace("pi-ssh-tools-description-");
useFakeRemoteHost(workspace);

const extension = await loadExtension();
await activateSsh(extension, workspace);

const PATH_NOTE = "Relative paths are resolved against the active remote working directory; ~ is the remote user's home.";

const PAIRS: Array<{ tool: string; base: () => any; notesPaths: boolean }> = [
	{ tool: "ssh_read", base: () => createReadToolDefinition(workspace.local), notesPaths: true },
	{ tool: "ssh_write", base: () => createWriteToolDefinition(workspace.local), notesPaths: true },
	{ tool: "ssh_edit", base: () => createEditToolDefinition(workspace.local), notesPaths: true },
	{ tool: "ssh_bash", base: () => createBashToolDefinition(workspace.local), notesPaths: false },
];

function sentences(text: string): string[] {
	return text.split(/(?<=\.)\s+/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "");
}

for (const pair of PAIRS) {
	test(`${pair.tool} says what pi says, and only adds where the host matters`, () => {
		const ours = sentences(extension.tools.get(pair.tool).description);
		const theirs = sentences(pair.base().description);

		const dropped = theirs.slice(1).filter((sentence) => !ours.includes(sentence));
		assert.deepEqual(dropped, [], `${pair.tool} stopped saying something pi tells the model:\n${dropped.map((sentence) => `  - ${sentence}`).join("\n")}`);

		const added = ours.filter((sentence) => !theirs.includes(sentence));
		assert.deepEqual(
			added.filter((sentence) => sentence !== ours[0]),
			pair.notesPaths ? [PATH_NOTE] : [],
			`${pair.tool} added prose that is neither the opening sentence nor the note about paths`,
		);

		// One sentence more than pi, or the same number: the opening sentence is rewritten in place,
		// not added, so a count that grows by two means something was duplicated on the way.
		assert.equal(ours.length, theirs.length + (pair.notesPaths ? 1 : 0), `${pair.tool} changed the number of sentences without saying what it replaced:\n ours: ${JSON.stringify(ours, null, 1)}\n  pi: ${JSON.stringify(theirs, null, 1)}`);

		assert.match(ours[0], /active SSH host/, `${pair.tool} does not say up front which machine it works on: ${ours[0]}`);
		assert.equal(ours[0].split(" ")[0], theirs[0].split(" ")[0], `${pair.tool} opens with a different verb than pi's ${pair.tool.slice(4)}`);
	});
}

test("the ssh tools are the four pi tools with the same wiring", () => {
	// The name and the prose are the parts meant to differ; anything else that diverges means the
	// tool is not the same tool any more, and the model will treat it differently.
	for (const pair of PAIRS) {
		const mine = extension.tools.get(pair.tool);
		const base = pair.base();
		// Wiring is what makes an ssh tool the same tool on another machine. If any of this drifts,
		// the model gets a different shape of tool and no amount of good wording makes it behave.
		for (const field of ["renderShell", "executionMode", "constrainedSampling", "parameters", "outputSchema"]) {
			assert.deepEqual(mine[field], base[field], `${pair.tool}.${field} no longer matches pi's`);
		}
		// The prose - summary and guidelines - may differ, but only by pointing at the host. A
		// guideline that stops saying so quietly sends the model back to the local machine.
		for (const [field, text] of [["summary", mine.promptSnippet], ["guidelines", (mine.promptGuidelines ?? []).join(" ")]]) {
			if (text) {
				assert.match(text, /SSH|remote/i, `${pair.tool}'s ${field} no longer say where the work happens: ${text}`);
			}
		}
	}
});
