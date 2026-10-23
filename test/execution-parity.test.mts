import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

import { activateSsh, comparable, createWorkspace, loadExtension, resetTree, resetWorkspace, runTool, sshCallCount, useFakeRemoteHost } from "./support/harness.mts";

/**
 * The claim these tests hold: an ssh tool is pi's tool with the filesystem swapped out, so the
 * same bytes in and the same call out have to produce the same answer for the model. Anything that
 * differs is either listed below with the reason it cannot match, or fails.
 */

const workspace = createWorkspace("pi-ssh-tools-execution-");
useFakeRemoteHost(workspace);

const extension = await loadExtension();
await activateSsh(extension, workspace);

const native = new Map<string, any>([
	["ssh_read", createReadToolDefinition(workspace.local)],
	["ssh_write", createWriteToolDefinition(workspace.local)],
	["ssh_edit", createEditToolDefinition(workspace.local)],
	["ssh_bash", createBashToolDefinition(workspace.local)],
]);

type Case = { tool: string; name: string; params: any };

const CASES: Case[] = [
	// read
	{ tool: "ssh_read", name: "plain file", params: { path: "notes.txt" } },
	{ tool: "ssh_read", name: "crlf file", params: { path: "crlf.txt" } },
	{ tool: "ssh_read", name: "bom file", params: { path: "bom.txt" } },
	{ tool: "ssh_read", name: "empty file", params: { path: "empty.txt" } },
	{ tool: "ssh_read", name: "missing file", params: { path: "nope.txt" } },
	{ tool: "ssh_read", name: "directory", params: { path: "sub" } },
	{ tool: "ssh_read", name: "one huge line", params: { path: "longline.txt" } },
	{ tool: "ssh_read", name: "3000 lines", params: { path: "many.txt" } },
	{ tool: "ssh_read", name: "offset and limit", params: { path: "many.txt", offset: 10, limit: 5 } },
	{ tool: "ssh_read", name: "tilde path", params: { path: "~/notes.txt" } },
	{ tool: "ssh_read", name: "absolute inside root", params: { path: `${workspace.remote}/notes.txt` } },
	// Images. The name and the bytes disagree on purpose; pi believes the bytes, so this has to as well.
	{ tool: "ssh_read", name: "png named for what it is", params: { path: "pic.png" } },
	{ tool: "ssh_read", name: "png named .dat", params: { path: "pic.dat" } },
	{ tool: "ssh_read", name: "text named .png", params: { path: "fake.png" } },
	{ tool: "ssh_read", name: "animated png", params: { path: "anim.png" } },
	{ tool: "ssh_read", name: "bmp", params: { path: "logo.bmp" } },
	{ tool: "ssh_read", name: "jpeg", params: { path: "shot.jpg" } },
	{ tool: "ssh_read", name: "gif", params: { path: "clip.gif" } },
	{ tool: "ssh_read", name: "webp", params: { path: "wide.webp" } },
	{ tool: "ssh_read", name: "png signature only", params: { path: "sig.txt" } },
	// write
	{ tool: "ssh_write", name: "new file", params: { path: "new.txt", content: "hello\n" } },
	{ tool: "ssh_write", name: "nested new dirs", params: { path: "a/b/c/new.txt", content: "deep\n" } },
	{ tool: "ssh_write", name: "overwrite", params: { path: "notes.txt", content: "replaced\n" } },
	{ tool: "ssh_write", name: "empty content", params: { path: "notes.txt", content: "" } },
	{ tool: "ssh_write", name: "no trailing newline", params: { path: "notes.txt", content: "one" } },
	{ tool: "ssh_write", name: "crlf content", params: { path: "notes.txt", content: "a\r\nb\r\n" } },
	{ tool: "ssh_write", name: "absolute outside root", params: { path: `${workspace.home}/outside.txt`, content: "outside\n" } },
	// edit
	{ tool: "ssh_edit", name: "single edit", params: { path: "notes.txt", edits: [{ oldText: "beta", newText: "BETA" }] } },
	{ tool: "ssh_edit", name: "crlf preserved", params: { path: "crlf.txt", edits: [{ oldText: "b", newText: "B" }] } },
	{ tool: "ssh_edit", name: "bom preserved", params: { path: "bom.txt", edits: [{ oldText: "y", newText: "Y" }] } },
	{ tool: "ssh_edit", name: "missing file", params: { path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] } },
	{ tool: "ssh_edit", name: "no match", params: { path: "notes.txt", edits: [{ oldText: "absent", newText: "b" }] } },
	{ tool: "ssh_edit", name: "ambiguous match", params: { path: "many.txt", edits: [{ oldText: "line 1", newText: "X" }] } },
	{ tool: "ssh_edit", name: "tilde path", params: { path: "~/notes.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] } },
	{ tool: "ssh_edit", name: "absolute inside root", params: { path: `${workspace.remote}/notes.txt`, edits: [{ oldText: "beta", newText: "BETA" }] } },
	{ tool: "ssh_edit", name: "absolute outside root", params: { path: `${workspace.home}/notes.txt`, edits: [{ oldText: "beta", newText: "BETA" }] } },
	{ tool: "ssh_edit", name: "directory", params: { path: "sub", edits: [{ oldText: "a", newText: "b" }] } },
	// bash
	{ tool: "ssh_bash", name: "echo", params: { command: "echo hi" } },
	{ tool: "ssh_bash", name: "stderr merged", params: { command: "echo out; echo err >&2" } },
	{ tool: "ssh_bash", name: "failing first in a list", params: { command: "false; echo hi" } },
	{ tool: "ssh_bash", name: "grep miss then echo", params: { command: "grep zzz notes.txt; echo done" } },
	{ tool: "ssh_bash", name: "exit code 3", params: { command: "exit 3" } },
	{ tool: "ssh_bash", name: "cd to missing dir", params: { command: "cd no-such-dir; pwd" } },
	{ tool: "ssh_bash", name: "timeout", params: { command: "sleep 3", timeout: 1 } },
	{ tool: "ssh_bash", name: "big output", params: { command: "seq 1 4000" } },
	{ tool: "ssh_bash", name: "cwd is the remote root", params: { command: "pwd" } },
	{ tool: "ssh_bash", name: "multiline heredoc", params: { command: "cat <<'EOF'\nx\nEOF" } },
];

/**
 * The cases that cannot be identical, and why. A case listed here that starts matching is a
 * failure too: the reason it was listed has gone away and the list should say so.
 */
const CANNOT_MATCH = new Map<string, string>([
	["ssh_read / missing file", "a remote shell reports a missing file in words; a local one throws ENOENT"],
	["ssh_read / directory", "a remote shell says what its check found; a local read throws EISDIR"],
	["ssh_edit / missing file", "a remote shell reports a missing file in words; a local one throws ENOENT"],
	["ssh_edit / directory", "a remote shell refuses a directory explicitly; a local read throws EISDIR"],
	// pi has no remote home to expand against, so the local tool has no file to find at all.
	["ssh_read / tilde path", "the file is on the host; locally there is nothing at that path"],
	["ssh_edit / tilde path", "the file is on the host; locally there is nothing at that path"],
	[
		"ssh_bash / cd to missing dir",
		"the working-directory check is the first line of a script fed to the remote shell, so the shell blames a different line than it would locally",
	],
]);

const compare = comparable(workspace);

for (const testCase of CASES) {
	test(`${testCase.tool} ${testCase.name}`, async () => {
		resetWorkspace(workspace);
		const mine = await runTool(extension.tools.get(testCase.tool), testCase.params, workspace.local);
		resetWorkspace(workspace);
		const base = await runTool(native.get(testCase.tool), testCase.params, workspace.local);

		const key = `${testCase.tool} / ${testCase.name}`;
		const expected = CANNOT_MATCH.get(key);
		const before = compare(mine);
		const after = compare(base);
		if (before === after) {
			assert.equal(expected, undefined, `${key} matches pi now, so the reason it was listed as unmatchable has gone away`);
			return;
		}
		assert.ok(expected, `${key} differs from pi, and nothing says why:\n  ssh: ${before}\n  pi:  ${after}`);
	});
}

test("ssh tools write where the local tools write", async () => {
	// A cheaper check than comparing every result: after each side has run the same calls, the two
	// trees have to hold the same bytes.
	resetWorkspace(workspace);
	const calls: Array<[string, any]> = [
		["ssh_write", { path: "made/new.txt", content: "made\n" }],
		["ssh_edit", { path: "notes.txt", edits: [{ oldText: "beta", newText: "BETA" }] }],
		["ssh_bash", { command: "echo from-bash > from-bash.txt" }],
	];
	for (const [tool, params] of calls) {
		await runTool(extension.tools.get(tool), params, workspace.local);
		await runTool(native.get(tool), params, workspace.local);
	}
	for (const file of ["made/new.txt", "notes.txt", "from-bash.txt"]) {
		assert.deepEqual(
			readFileSync(`${workspace.remote}/${file}`),
			readFileSync(`${workspace.local}/${file}`),
			`${file} differs between the remote tree and the local one`,
		);
	}
});

test("reading a file costs two round trips", async () => {
	// One call checks the file and takes the bytes an image would be recognised from, the other
	// reads the file. A third would mean the image sniffing was billed separately.
	resetTree(workspace.remote);
	const before = sshCallCount(workspace);
	await runTool(extension.tools.get("ssh_read"), { path: "notes.txt" }, workspace.local);
	assert.equal(sshCallCount(workspace) - before, 2);
});
