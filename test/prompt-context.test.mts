import assert from "node:assert/strict";
import test from "node:test";

import { activateSsh, createWorkspace, loadExtension, runSshCommand, useFakeRemoteHost } from "./support/harness.mts";

/**
 * The per-turn system prompt is the only place this package talks to the model about the
 * workspace, so it carries exactly what the model acts on: the host, the remote cwd, and the four
 * tools. What `!`, `!!` do, and the `local:` marker that keeps one of those commands on the user's
 * machine, belong to the terminal - the model cannot type them, so naming them only asks it to
 * reason about a command line that is not there.
 */

const workspace = createWorkspace("pi-ssh-tools-prompt-");
useFakeRemoteHost(workspace);

const extension = await loadExtension();
await activateSsh(extension, workspace);

const BASE_PROMPT = "You are pi.";

const ctx = {
	cwd: workspace.local,
	hasUI: false,
	ui: {
		setWidget: () => {},
		setStatus: () => {},
		setFooter: () => {},
		notify: () => {},
		theme: { fg: (_color: string, text: string) => text },
	},
} as any;

/** Run every `before_agent_start` handler in order, the way pi composes them. */
async function startTurn(): Promise<string> {
	const handlers = extension.handlers.get("before_agent_start") ?? [];
	assert.ok(handlers.length > 0, "the extension registered no before_agent_start handler");
	let prompt = BASE_PROMPT;
	for (const handler of handlers) {
		const result = await handler({ type: "before_agent_start", systemPrompt: prompt }, ctx);
		if (typeof result?.systemPrompt === "string") {
			prompt = result.systemPrompt;
		}
	}
	return prompt;
}

test("the turn prompt names the host, the remote cwd, and the tools", async () => {
	const appended = (await startTurn()).slice(BASE_PROMPT.length);

	assert.match(appended, /Remote host: fakehost/, "the model is not told which machine it is on");
	assert.ok(appended.includes(workspace.remote), `the model is not told the remote cwd: ${appended}`);
	for (const tool of ["ssh_read", "ssh_write", "ssh_edit", "ssh_bash"]) {
		assert.ok(appended.includes(tool), `the model is not pointed at ${tool}`);
	}
});

test("the turn prompt leaves the user's own command routing out of the model's context", async () => {
	const appended = (await startTurn()).slice(BASE_PROMPT.length);

	assert.ok(!appended.includes("local:"), `the local: marker is user-only, yet the model reads ${JSON.stringify(appended)}`);
	assert.ok(!appended.includes("!"), `! and !! are typed by the user, yet the model reads ${JSON.stringify(appended)}`);
});

test("with SSH mode off the prompt is left exactly as pi built it", async () => {
	await runSshCommand(extension, workspace, "off");

	assert.equal(await startTurn(), BASE_PROMPT);
});
