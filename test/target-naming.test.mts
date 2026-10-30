import assert from "node:assert/strict";
import test from "node:test";

import {
	createWorkspace,
	loadLivePi,
	plain,
	rowText,
	toolRow,
	useFakeRemoteHost,
	textResult,
	type LiveSession,
} from "./support/harness.mts";

/**
 * A workspace can be named two ways: `/ssh mac` takes the directory from the ssh config or the
 * remote home, `/ssh mac:/srv/app` names host and directory in one string. Every screen has to say
 * the host and the directory once each whichever way it was written, because `mac:/srv/app:/srv/app`
 * says nothing useful about either.
 */

const workspace = createWorkspace("pi-ssh-tools-naming-");
useFakeRemoteHost(workspace);

const pi = await loadLivePi();
const host = "devbox";

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

/** What a screen shows: one host, one directory, no doubled path. */
function namesHostAndDirectoryOnce(where: string, text: string, directory: string) {
	assert.equal(countOf(text, host), 1, `${where} does not name the host exactly once: ${text}`);
	assert.equal(countOf(text, directory), 1, `${where} prints the remote directory twice: ${text}`);
}

const opened = async (argument: string): Promise<LiveSession> => {
	const session = await pi.start("startup", { cwd: workspace.local });
	await pi.ssh(session, argument);
	return session;
};

/** The lines of the workspace notice above the editor, or none if nothing is on screen. */
const noticeLines = (session: LiveSession) =>
	session.widgets
		.filter((widget) => widget.lines !== undefined)
		.at(-1)!
		.lines!.map((line: string) => plain(line))
		.join("\n");

const rowHeader = async (session: LiveSession, tool: string, args: unknown): Promise<string> => {
	const component = await toolRow(session.tools.get(tool), args, textResult("ok"), workspace.local);
	return rowText(component).join("\n");
};

test("a host typed with its directory is named once everywhere", async () => {
	const directory = `${workspace.remote}/api`;
	const session = await opened(`${host}:${directory}`);

	namesHostAndDirectoryOnce("the notice that SSH mode is on", session.notices.at(-1)!.message, directory);
	namesHostAndDirectoryOnce("the footer", plain(session.statuses.at(-1)!), directory);


	await pi.ssh(session, "status");
	namesHostAndDirectoryOnce("/ssh status", session.notices.at(-1)!.message, directory);

	for (const [tool, args] of [
		["ssh_read", { path: "main.ts" }],
		["ssh_write", { path: "main.ts", content: "export const answer = 42;\n" }],
		["ssh_edit", { path: "main.ts", edits: [{ oldText: "41", newText: "42" }] }],
		["ssh_bash", { command: "pwd" }],
	] as const) {
		const header = await rowHeader(session, tool, args);
		assert.ok(header.includes(`[${host}]`), `${tool} does not badge its row with the host: ${header}`);
		assert.ok(!header.includes(directory), `${tool} repeats the remote directory: ${header}`);
	}

	// The notice above the editor is put up when a workspace is restored, not when it is
	// opened, so the workspace is carried into the next session to see it.
	const restored = await pi.replace(session, "new");
	namesHostAndDirectoryOnce("the workspace notice", noticeLines(restored), directory);

	// The reconnect hint is where the typed form is right, so it is read apart from the label: the
	// label carries the directory once, and the hint hands back exactly what was typed.
	await pi.ssh(restored, "off");
	const forked = await pi.replace(restored, "fork");
	const staysOff = forked.notices.at(-1)!.message;
	const [label, hint] = staysOff.split(" - ");
	namesHostAndDirectoryOnce("the notice that a closed workspace stays closed", label, directory);
	assert.equal(hint, `/ssh ${host}:${directory} reconnects`, `the reconnect hint changed: ${staysOff}`);

	await pi.shutdown(forked, "quit");
});

test("a host named on its own is named the same way", async () => {
	// With no directory in the argument the remote home is asked for, so the directory the screens
	// show is the one that came back rather than one written down.
	const session = await opened(host);
	const directory = workspace.home;

	namesHostAndDirectoryOnce("the notice that SSH mode is on", session.notices.at(-1)!.message, directory);
	namesHostAndDirectoryOnce("the footer", plain(session.statuses.at(-1)!), directory);
	await pi.ssh(session, "status");
	namesHostAndDirectoryOnce("/ssh status", session.notices.at(-1)!.message, directory);

	const header = await rowHeader(session, "ssh_bash", { command: "pwd" });
	assert.ok(header.includes(`[${host}]`), `the row does not badge the host: ${header}`);

	await pi.shutdown(session, "quit");
});
