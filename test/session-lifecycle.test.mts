import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspace, loadLivePi, recordedStates, useFakeRemoteHost, type LiveSession } from "./support/harness.mts";

/**
 * A workspace has a lifecycle: `/ssh <host>` opens it, `/ssh off` closes it. Closing is recorded in
 * the session that recorded it, so `/resume` and `/fork` of that branch do not resurrect it, but it
 * is also the end: the next `/new` must start with no workspace at all, and must hand nothing on,
 * or one closed connection would name a host in every session after it, forever.
 */

const SSH_TOOLS = ["ssh_read", "ssh_write", "ssh_edit", "ssh_bash"];

const workspace = createWorkspace("pi-ssh-tools-lifecycle-");
useFakeRemoteHost(workspace);

const pi = await loadLivePi();

const target = () => `fakehost:${workspace.remote}`;
const sshTools = (session: LiveSession) => session.activeTools.filter((name) => SSH_TOOLS.includes(name));
const latestStatus = (session: LiveSession) => session.statuses.at(-1);
const liveWidgets = (session: LiveSession) => session.widgets.filter((widget) => widget.lines !== undefined);

/** Start a generation that never used SSH: `/startup` reads neither a branch nor the handoff slot. */
const startFresh = () => pi.start("startup", { cwd: workspace.local });

test("a live workspace crosses into the session /new starts", async () => {
	const first = await startFresh();
	assert.deepEqual(recordedStates(first), [], "a session that never used SSH recorded a workspace");

	await pi.ssh(first, target());
	const second = await pi.replace(first, "new");

	assert.deepEqual(sshTools(second).sort(), [...SSH_TOOLS].sort(), "/new did not put the ssh tools back");
	assert.match(latestStatus(second) ?? "", /SSH fakehost/, "/new does not say which host it is on");
	assert.equal(liveWidgets(second).length, 1, "/new did not put the workspace notice back");
	const [recorded] = recordedStates(second);
	assert.equal(recorded?.active, true, "/new recorded a workspace that is not connected");
	assert.equal(recorded?.remoteCwd, workspace.remote, "/new recorded the wrong workspace");

	// The host itself is asked about in the background, so the answer cannot land in a later case.
	await pi.shutdown(second, "quit");
});

test("/ssh off ends the workspace, so /new starts clean", async () => {
	const first = await startFresh();
	await pi.ssh(first, target());
	await pi.ssh(first, "off");
	assert.deepEqual(sshTools(first), [], "/ssh off left the ssh tools active");

	const second = await pi.replace(first, "new");
	assert.deepEqual(sshTools(second), [], "/new gave the ssh tools back to a closed workspace");
	assert.equal(latestStatus(second), undefined, "/new still shows a host in the footer");
	assert.deepEqual(liveWidgets(second), [], "/new announced a workspace nobody opened");
	assert.deepEqual(second.notices, [], `/new reported a closed workspace: ${JSON.stringify(second.notices)}`);
	assert.deepEqual(recordedStates(second), [], "/new wrote a closed workspace into its own session file");

	// The closed workspace must not be handed on a second time: this is the hop that used to run
	// forever, each new session inheriting the host the one before had finished with.
	const third = await pi.replace(second, "new");
	assert.deepEqual(sshTools(third), [], "a second /new resurrected the closed workspace");
	assert.deepEqual(third.notices, [], "a second /new still talked about the closed workspace");
	assert.deepEqual(recordedStates(third), [], "a second /new recorded the closed workspace");

	const fourth = await pi.replace(third, "new");
	assert.deepEqual(sshTools(fourth), [], "a third /new resurrected the closed workspace");
	assert.deepEqual(fourth.notices, [], "a third /new still talked about the closed workspace");

	await pi.shutdown(fourth, "quit");
});

/** A branch that recorded the close keeps it: the record is the transcript's, not the process's. */
test("/ssh off is still honoured by the branch that recorded it", async () => {
	const first = await startFresh();
	await pi.ssh(first, target());
	await pi.ssh(first, "off");

	const forked = await pi.replace(first, "fork");
	assert.deepEqual(sshTools(forked), [], "/fork put a closed workspace back on");
	assert.equal(latestStatus(forked), undefined, "/fork shows a host that is not connected");
	assert.match(
		forked.notices.map((notice) => notice.message).join("\n"),
		/SSH mode stays off/,
		"/fork did not say the workspace is closed at this point",
	);
	assert.equal(liveWidgets(forked).length, 0, "/fork announced a closed workspace as live");

	// Closing is a fact about the branch, so the session after a forked one is still clean.
	const next = await pi.replace(forked, "new");
	assert.deepEqual(sshTools(next), [], "/new after a closed fork resurrected the workspace");
	assert.deepEqual(next.notices, [], "/new after a closed fork talked about the workspace");

	await pi.shutdown(next, "quit");
});

test("/ssh off after a restored workspace still ends it", async () => {
	const first = await startFresh();
	await pi.ssh(first, target());
	const second = await pi.replace(first, "new");
	assert.deepEqual(sshTools(second).sort(), [...SSH_TOOLS].sort(), "the restored workspace lost its tools");

	await pi.ssh(second, "off");
	const third = await pi.replace(second, "new");
	assert.deepEqual(sshTools(third), [], "/new brought back tools for a workspace closed in the previous session");
	assert.deepEqual(third.notices, [], "/new talked about a workspace closed in the previous session");
	assert.deepEqual(recordedStates(third), [], "/new recorded a workspace it never had");

	// A clean session can still open a workspace, so the handoff itself kept working.
	await pi.ssh(third, target());
	const fourth = await pi.replace(third, "new");
	assert.deepEqual(sshTools(fourth).sort(), [...SSH_TOOLS].sort(), "/new stopped carrying a live workspace");

	await pi.shutdown(fourth, "quit");
});

test("quitting hands nothing to the next pi process", async () => {
	const first = await startFresh();
	await pi.ssh(first, target());
	await pi.shutdown(first, "quit");

	// A new process reads neither a handoff nor a branch, so a workspace cannot come back by itself.
	const second = await pi.start("startup", { cwd: workspace.local });
	assert.deepEqual(sshTools(second), [], "a session started after quitting came up with ssh tools");
	await pi.shutdown(second, "quit");
});
