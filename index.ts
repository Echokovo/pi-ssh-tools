import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createLocalBashOperations,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	formatReadLineRange,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	type ReadOperations,
	renderDiff,
	type SessionEntry,
	type Theme,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";

type SshProfile = {
	name: string;
	remote: string;
	cwd?: string;
};

type ActiveSshTarget = {
	name: string;
	remote: string;
	remoteCwd: string;
	/** The remote home query, filled the first time a `~` path needs it. */
	remoteHome?: Promise<string>;
};

type SshExecOptions = {
	stdin?: string | Buffer;
	signal?: AbortSignal;
	onStdoutData?: (data: Buffer) => void;
	onStderrData?: (data: Buffer) => void;
	timeoutSeconds?: number;
	/** Shorter ConnectTimeout for probes; every call already refuses to ask. */
	connectTimeoutSeconds?: number;
};

const SSH_STATUS_KEY = "ssh-tools";
const SSH_NOTICE_KEY = "ssh-tools-notice";
const SSH_TOOL_NAMES = ["ssh_read", "ssh_write", "ssh_edit", "ssh_bash"] as const;

/** How the optional pi-permission-system integration ended up for this session. */
type PermissionGateState = "pending" | "registered" | "missing";

/** The one call pi-ssh-tools needs from a pi-permission-system service: declare a tool's access intent. */
type PermissionPathGateRegistrar = {
	registerToolAccessExtractor?: (
		toolName: string,
		extractor: (input: Record<string, unknown>) => string | undefined,
	) => () => void;
};

/**
 * The process-global slot pi-permission-system publishes each node's service into.
 * Read directly instead of `import("@gotgenes/pi-permission-system")`, which cannot
 * resolve from a git-installed package: its directory tree holds no node_modules.
 */
const PERMISSION_SERVICES_KEY = Symbol.for("@gotgenes/pi-permission-system:session-services");

/** The ssh tools whose `path` names a REMOTE file and must stay invisible to local path gates. */
const PATH_GATED_SSH_TOOLS = ["ssh_read", "ssh_write", "ssh_edit"];

const PERMISSION_GATE_NOTES: Record<PermissionGateState, string> = {
	pending: "permission-system integration still pending",
	registered: "remote paths are exempt from the local path gates",
	missing: "permission-system service not found - remote paths are still judged as local paths",
};
const SSH_CONFIG_PATH = join(homedir(), ".ssh", "config");
/** Prefix a `!` / `!!` command with this to keep it on the local machine while SSH mode is on. */
const LOCAL_BASH_MARKER = "local:";

/**
 * Session entry type carrying the SSH workspace across /new, /fork, /clone, and /resume.
 * Plain custom entries are not sent to the model, so this is extension state only.
 */
const SESSION_STATE_ENTRY_TYPE = "pi-ssh-tools:target";
const SESSION_STATE_VERSION = 1;

/**
 * Handoff slot for the session generations whose file does not carry our entry yet.
 * pi keeps one process across a session replacement, and /reload re-imports this module
 * (it clears the extension module cache), so module-level state cannot be the carrier -
 * globalThis can.
 */
const SESSION_HANDOFF_KEY = Symbol.for("pi-ssh-tools:session-handoff");

/** How long a restored workspace waits for the background reachability probe. */
const PROBE_TIMEOUT_SECONDS = 5;

/**
 * ssh reports its own failures as 255 and passes the remote command's status
 * through for everything else, so 255 means "the call never ran".
 */
const SSH_TRANSPORT_EXIT_CODE = 255;
/** A real call gets more room than a probe: the user is waiting on this one. */
const SSH_CONNECT_TIMEOUT_SECONDS = 10;
/** Notice a dead link after ~45s instead of on the next write, and keep idle NAT and proxy timers from dropping a healthy one. */
const SSH_KEEPALIVE_INTERVAL_SECONDS = 15;
const SSH_KEEPALIVE_COUNT_MAX = 3;
/**
 * How long to keep reading after the ssh client has exited. Output still arriving
 * re-arms this, so only a quiet pipe ends the call.
 */
const SSH_STDIO_GRACE_MS = 100;
/**
 * Hard limit on reading the pipes after the client exited, however busy they still
 * are: a remote job that outlived its channel keeps a mux master writing forever.
 */
const SSH_DRAIN_CAP_MS = 5000;
/** SIGTERM the client's group, and insist with SIGKILL when it will not go. */
const SSH_KILL_ESCALATION_MS = 750;
/**
 * A control call (`/ssh <host>`, a `~` lookup) has no keypress waiting behind it, so
 * it must not sit on a half-open link forever. Generous next to ConnectTimeout=10.
 */
const SSH_CONTROL_TIMEOUT_SECONDS = 30;

/**
 * Opt-in call log: `PI_SSH_TOOLS_DEBUG=1 pi`. The tool error is what the model sees and
 * it is deliberately short; this file is what a human reads when a call makes no sense.
 * Remote command text and stderr go in, file content never does.
 */
const DEBUG_LOG_PATH = process.env.PI_SSH_TOOLS_DEBUG ? join(tmpdir(), "pi-ssh-tools.log") : null;

function logSshCall(entry: string): void {
	if (!DEBUG_LOG_PATH) {
		return;
	}
	try {
		appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${entry}\n`, "utf8");
	} catch {
		// A log that cannot be written must not break the call it describes.
	}
}

/** One line per call: what ran, how it ended, what ssh said. Never the file content. */
function describeSshCall(remote: string, command: string, exitCode: number | null, ms: number, stderr: Buffer): string {
	const summary = (value: string, limit: number) => JSON.stringify(value.length > limit ? `${value.slice(0, limit)}...` : value);
	const errorText = stderr.toString("utf8").trim();
	return `${remote} exit=${exitCode} ${ms}ms cmd=${summary(command, 160)}${errorText ? ` stderr=${summary(errorText, 300)}` : ""}`;
}

type SshSessionState = {
	version: number;
	active: boolean;
	name: string;
	remote: string;
	remoteCwd: string;
};

/** Where the currently applied workspace came from. */
type StateOrigin = "none" | "session" | "handoff" | "carried" | "manual";

const STATE_ORIGIN_NOTES: Record<StateOrigin, string> = {
	none: "started in this session",
	session: "restored from this session file",
	handoff: "inherited from the previous session",
	carried: "carried over when you changed branch",
	manual: "selected in this session",
};

/** Keyed by cwd so one process serving several cwds does not mix workspaces. */
type SshHandoffStore = Record<string, SshSessionState | null>;

function sshHandoffStore(): SshHandoffStore {
	const host = globalThis as unknown as Record<symbol, SshHandoffStore | undefined>;
	let store = host[SESSION_HANDOFF_KEY];
	if (!store) {
		store = {};
		host[SESSION_HANDOFF_KEY] = store;
	}
	return store;
}

function readHandoff(cwd: string): SshSessionState | null {
	return sshHandoffStore()[cwd] ?? null;
}

function writeHandoff(cwd: string, state: SshSessionState | null): void {
	sshHandoffStore()[cwd] = state;
}

/** Session files outlive package versions and are user-editable: validate, never trust. */
function toSshSessionState(value: unknown): SshSessionState | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (record.version !== SESSION_STATE_VERSION) {
		return null;
	}
	if (typeof record.active !== "boolean") {
		return null;
	}
	if (typeof record.name !== "string" || !record.name) {
		return null;
	}
	if (typeof record.remote !== "string" || !record.remote) {
		return null;
	}
	if (typeof record.remoteCwd !== "string" || !record.remoteCwd) {
		return null;
	}
	return {
		version: SESSION_STATE_VERSION,
		active: record.active,
		name: record.name,
		remote: record.remote,
		remoteCwd: record.remoteCwd,
	};
}

/** Newest recorded workspace on the path from the session root to the current leaf. */
function findSessionState(entries: readonly SessionEntry[]): SshSessionState | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY_TYPE) {
			continue;
		}
		const state = toSshSessionState(entry.data);
		if (state) {
			return state;
		}
	}
	return null;
}

function sameSessionState(left: SshSessionState | null, right: SshSessionState | null): boolean {
	if (!left || !right) {
		return left === right;
	}
	return (
		left.active === right.active &&
		left.name === right.name &&
		left.remote === right.remote &&
		left.remoteCwd === right.remoteCwd
	);
}

/** First non-empty line, shortened: turns ssh stderr or an Error into one notify line. */
function summarizeError(value: unknown, max = 160): string {
	const line = String((value as Error)?.message ?? value ?? "")
		.split("\n")
		.find((candidate) => candidate.trim())
		?.trim();
	if (!line) {
		return "";
	}
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizeRemoteDir(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The remote user's home directory: asked once per target, and only when a path
 * actually starts with `~`, so the common call costs no extra round trip.
 */
function remoteHomeDir(target: ActiveSshTarget): Promise<string> {
	if (!target.remoteHome) {
		// A timeout rather than the caller's signal: this one promise is shared by every
		// later `~` path, so letting one aborted call reject it would break the others.
		target.remoteHome = sshOk(target.remote, 'printf %s "$HOME"', {
			timeoutSeconds: SSH_CONTROL_TIMEOUT_SECONDS,
		})
			.then((value) => {
				const home = value.toString("utf8").trim();
				if (!home.startsWith("/")) {
					throw new Error(`Could not determine the home directory on ${target.remote}. Use a path relative to ${target.remoteCwd}.`);
				}
				return normalizeRemoteDir(home);
			})
			.catch((error: unknown) => {
				// A cached rejection would outlive the outage; let a later call ask again.
				target.remoteHome = undefined;
				throw error;
			});
	}
	return target.remoteHome;
}

/**
 * `~` is the one path form pi cannot carry over: normalizePath() expands it against the
 * LOCAL home before the operations layer ever sees the path, so `~/notes.md` reached the
 * remote host as `/home/<you>/notes.md` - right only when both machines happened to
 * agree, and ssh_write would even mkdir it. Expanding it here makes `~` mean the remote
 * home, the way a `!` command on the same host already reads it. Relative and absolute
 * paths are left to pi's own resolution, so they behave exactly like the built-in
 * read/write/edit. `~user` is refused rather than guessed: pi turns it into a literal
 * `~user` directory.
 */
async function expandRemoteTilde(toolName: string, path: string, target: ActiveSshTarget): Promise<string> {
	if (typeof path !== "string" || !path.startsWith("~")) {
		return path;
	}
	if (path === "~") {
		return remoteHomeDir(target);
	}
	if (path.startsWith("~/")) {
		return `${await remoteHomeDir(target)}/${path.slice(2)}`;
	}
	throw new Error(`${toolName} does not expand ~user paths. Use ~ or a path relative to ${target.remoteCwd}.`);
}

function withCwd<T>(ctx: T, cwd: string): T {
	if (ctx === undefined || ctx === null || typeof ctx !== "object") {
		return ctx;
	}
	const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(ctx));
	delete (copy as Record<string, unknown>).cwd;
	Object.defineProperty(copy, "cwd", { value: cwd, enumerable: true, configurable: true, writable: true });
	return copy;
}

/**
 * Mirror of pi's internal `startToolTimer`, which the package does not export. It seeds the context
 * state `bashBase.renderResult` reads, so a running `ssh_bash` row ticks `Elapsed Xs` while the
 * command is still going instead of only reporting `Took Xs` once it ends.
 */
function startToolTimer(context: { executionStarted: boolean; state?: { startedAt?: number; endedAt?: number } }) {
	const state = context.state;
	if (state && context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
}

/**
 * Swap only pi's first sentence, the one that says where the file is. Whatever it goes on to say -
 * the truncation limits, the rules about how edits must not overlap - describes pi's own engine,
 * and every ssh tool runs that engine on a remote file, so those sentences stay word for word.
 */
function remoteToolDescription(baseDescription: string, lead: string, remoteNote = ""): string {
	const rest = baseDescription.replace(/^[^.]*\.\s*/, "");
	return [lead, rest, remoteNote].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/** The two ways a remote path differs from a local one, said once rather than in three places. */
const REMOTE_PATH_NOTE = "Relative paths are resolved against the active remote working directory; ~ is the remote user's home.";

function parseSshConfigProfiles(): SshProfile[] {
	if (!existsSync(SSH_CONFIG_PATH)) {
		return [];
	}

	const text = readFileSync(SSH_CONFIG_PATH, "utf8");
	const profiles = new Map<string, SshProfile>();

	for (const rawLine of text.split("\n")) {
		const withoutComment = rawLine.replace(/\s+#.*$/, "").trim();
		if (!withoutComment) continue;

		const match = withoutComment.match(/^Host\s+(.+)$/i);
		if (!match) continue;

		const aliases = match[1]
			.split(/\s+/)
			.map((alias) => alias.trim())
			.filter(Boolean)
			.filter((alias) => !alias.includes("*") && !alias.includes("?") && !alias.startsWith("!"));

		for (const alias of aliases) {
			if (!profiles.has(alias)) {
				profiles.set(alias, { name: alias, remote: alias });
			}
		}
	}

	return Array.from(profiles.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeTargetArg(arg: string, profiles: SshProfile[]): SshProfile {
	const trimmed = arg.trim();
	const matchedProfile = profiles.find((profile) => profile.name === trimmed);
	if (matchedProfile) {
		return matchedProfile;
	}

	const separatorIndex = trimmed.indexOf(":");
	if (separatorIndex > 0) {
		return {
			name: trimmed,
			remote: trimmed.slice(0, separatorIndex),
			cwd: trimmed.slice(separatorIndex + 1),
		};
	}

	return { name: trimmed, remote: trimmed };
}

/**
 * pi decides whether a read is an image by sniffing the leading bytes, never by name: a PNG
 * called `data.dat` is an image, and a `logo.png` that is really text is not. Its buffer form
 * of that check is not exported, so mirror it here - same sniff window, same signatures, same
 * rejections, because pi would not attach an animated PNG or a malformed BMP either.
 */
const IMAGE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWithBytes(buffer: Buffer, bytes: number[], offset = 0): boolean {
	return buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);
}

function startsWithAscii(buffer: Buffer, text: string, offset = 0): boolean {
	return startsWithBytes(buffer, [...Buffer.from(text, "ascii")], offset);
}

function hasPngHeader(buffer: Buffer): boolean {
	return buffer.length >= 16 && buffer.readUInt32BE(PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, "IHDR", 12);
}

/** Walk the chunk chain: an `acTL` before the first `IDAT` is the animation pi will not inline. */
function isAnimatedPng(buffer: Buffer): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = buffer.readUInt32BE(offset);
		if (startsWithAscii(buffer, "acTL", offset + 4)) {
			return true;
		}
		if (startsWithAscii(buffer, "IDAT", offset + 4)) {
			return false;
		}
		const next = offset + 8 + chunkLength + 4;
		if (next <= offset || next > buffer.length) {
			return false;
		}
		offset = next;
	}
	return false;
}

function isBmp(buffer: Buffer): boolean {
	if (buffer.length < 26) {
		return false;
	}
	const declaredFileSize = buffer.readUInt32LE(2);
	const pixelDataOffset = buffer.readUInt32LE(10);
	const dibHeaderSize = buffer.readUInt32LE(14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) {
		return false;
	}
	if (pixelDataOffset < 14 + dibHeaderSize) {
		return false;
	}
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) {
		return false;
	}
	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = buffer.readUInt16LE(22);
		bitsPerPixel = buffer.readUInt16LE(24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) {
			return false;
		}
		colorPlanes = buffer.readUInt16LE(26);
		bitsPerPixel = buffer.readUInt16LE(28);
	} else {
		return false;
	}
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function sniffImageMimeType(buffer: Buffer): string | null {
	if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWithBytes(buffer, PNG_SIGNATURE)) {
		return hasPngHeader(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, "GIF87a") || startsWithAscii(buffer, "GIF89a")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, "RIFF") && startsWithAscii(buffer, "WEBP", 8)) {
		return "image/webp";
	}
	if (startsWithAscii(buffer, "BM") && isBmp(buffer)) {
		return "image/bmp";
	}
	return null;
}

/**
 * Options on every ssh call. BatchMode is not a preference here: ssh reads a
 * passphrase or a host-key answer from /dev/tty, which is pi's keyboard rather than
 * the pipe we own, so an interactive host would either take over the TUI or hang on
 * the OS connect timeout (~2 minutes) before a single remote command ran.
 */
function sshBaseOptions(options: SshExecOptions): string[] {
	return [
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${options.connectTimeoutSeconds ?? SSH_CONNECT_TIMEOUT_SECONDS}`,
		"-o",
		`ServerAliveInterval=${SSH_KEEPALIVE_INTERVAL_SECONDS}`,
		"-o",
		`ServerAliveCountMax=${SSH_KEEPALIVE_COUNT_MAX}`,
	];
}

/**
 * Resolve when the ssh call is over, and never later than that.
 *
 * `close` is the wrong event to wait on: it fires at stdout and stderr EOF, and the
 * write end of those pipes is not held only by the client. With `ControlMaster` the
 * client hands the session's stdio to the mux master over the control socket, and that
 * master then outlives the client for as long as `ControlPersist` says; a forked helper
 * - `ProxyCommand`, `Match exec`, `PermitLocalCommand` - does the same. So after an
 * abort `close` never fires: the tool call never returns, pi's agent never goes idle,
 * and Esc has nothing left to cancel.
 *
 * Wait for the client to exit instead, then keep reading only until the pipes fall
 * idle. pi's own local shell does this through `waitForChildProcess`, which is not
 * exported, so it is spelled out here. Two bounds go past what pi needs locally,
 * because here the writer can be a process that is not ours to kill:
 *
 * - once termination has been requested, output no longer means "the command is
 *   finishing up" but "a session is still running remotely", so stop re-arming the
 *   idle timer and let it expire;
 * - untouched, a writer that outlived the client and keeps producing would hold the
 *   call open forever, so the drain gets an absolute deadline as well.
 */
function waitForSshCall(child: ChildProcess, shouldKeepDraining: () => boolean): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let drainCap: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const settle = () => {
			if (settled) {
				return;
			}
			settled = true;
			if (idleTimer) {
				clearTimeout(idleTimer);
			}
			if (drainCap) {
				clearTimeout(drainCap);
			}
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(exitCode);
		};
		const settleIfStreamsDone = () => {
			if (exited && stdoutEnded && stderrEnded) {
				settle();
			}
		};
		const armIdleTimer = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
			}
			idleTimer = setTimeout(settle, SSH_STDIO_GRACE_MS);
		};
		const onData = () => {
			if (exited && !settled && shouldKeepDraining()) {
				armIdleTimer();
			}
		};

		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.stdout?.once("end", () => {
			stdoutEnded = true;
			settleIfStreamsDone();
		});
		child.stderr?.once("end", () => {
			stderrEnded = true;
			settleIfStreamsDone();
		});
		child.once("exit", (code) => {
			exited = true;
			exitCode = code;
			settleIfStreamsDone();
			if (!settled) {
				armIdleTimer();
				drainCap = setTimeout(settle, SSH_DRAIN_CAP_MS);
			}
		});
		child.once("close", (code) => {
			exitCode = code;
			settle();
		});
		child.once("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			if (idleTimer) {
				clearTimeout(idleTimer);
			}
			if (drainCap) {
				clearTimeout(drainCap);
			}
			reject(error);
		});
	});
}

/** Process groups of the ssh clients still running, so a pi exit cannot leave one behind. */
const liveSshGroups = new Set<number>();
let sshExitCleanupInstalled = false;

function trackSshGroup(pid: number): void {
	if (!sshExitCleanupInstalled) {
		sshExitCleanupInstalled = true;
		// Only synchronous work is possible here, which sending a signal is.
		process.on("exit", () => {
			for (const tracked of liveSshGroups) {
				try {
					process.kill(-tracked, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		});
	}
	liveSshGroups.add(pid);
}

function sshExec(remote: string, command: string, options: SshExecOptions = {}) {
	return new Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }>((resolve, reject) => {
		const args: string[] = [...sshBaseOptions(options), remote, command];
		const startedAt = Date.now();
		// A process group of its own: ending the call has to reach whatever the client
		// forked as well, or the survivor keeps the pipes open and the link half-alive.
		const child = spawn("ssh", args, {
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timedOut = false;
		let terminating = false;
		let escalation: ReturnType<typeof setTimeout> | undefined;

		/** True when something was there to signal, which is what makes a log line worth having. */
		const killGroup = (signal: "SIGTERM" | "SIGKILL"): boolean => {
			if (!child.pid) {
				return false;
			}
			try {
				process.kill(-child.pid, signal);
				return true;
			} catch {
				try {
					return child.kill(signal);
				} catch {
					return false; // Already gone.
				}
			}
		};

		/** Abort and timeout end the call the same way: ask once, then insist. */
		const terminate = () => {
			terminating = true;
			killGroup("SIGTERM");
			if (!escalation) {
				escalation = setTimeout(() => {
					// A group still alive here is the finding: a forked helper, or a mux
					// master that was handed the session's stdio, outlived SIGTERM.
					if (killGroup("SIGKILL")) {
						logSshCall(`${remote} group ignored SIGTERM - killed with SIGKILL`);
					}
					if (child.pid) {
						liveSshGroups.delete(child.pid);
					}
				}, SSH_KILL_ESCALATION_MS);
				escalation.unref?.();
			}
		};

		const timer =
			typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
				? setTimeout(() => {
						timedOut = true;
						terminate();
					}, options.timeoutSeconds * 1000)
				: undefined;

		const cleanup = () => {
			if (timer) {
				clearTimeout(timer);
			}
			if (options.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			// Once termination has been requested the group is doomed even though the call
			// is over: the client exited, but a helper that ignores SIGTERM is still alive
			// and only the escalation clears it. Letting it run is what stops the leak.
			if (!terminating) {
				if (escalation) {
					clearTimeout(escalation);
				}
				if (child.pid) {
					liveSshGroups.delete(child.pid);
				}
			}
		};

		const onAbort = () => {
			terminate();
		};

		child.stdout?.on("data", (data: Buffer) => {
			stdoutChunks.push(data);
			options.onStdoutData?.(data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderrChunks.push(data);
			options.onStderrData?.(data);
		});

		if (child.pid && process.platform !== "win32") {
			trackSshGroup(child.pid);
		}

		waitForSshCall(child, () => !terminating).then(
			(exitCode) => {
				logSshCall(
					describeSshCall(remote, command, exitCode, Date.now() - startedAt, Buffer.concat(stderrChunks)),
				);
				cleanup();
				if (options.signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				if (timedOut) {
					reject(new Error(`timeout:${options.timeoutSeconds}`));
					return;
				}
				resolve({
					stdout: Buffer.concat(stdoutChunks),
					stderr: Buffer.concat(stderrChunks),
					exitCode,
				});
			},
			(error: unknown) => {
				logSshCall(`${remote} could not start: ${summarizeError(error)}`);
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);

		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		// ssh can exit before it reads stdin - a refused authentication or an unknown host
		// key does exactly that - and the failed write then emits EPIPE on this socket. An
		// unhandled 'error' event would take the process down with it, while the real
		// failure is already reported through the exit code and stderr.
		child.stdin?.on("error", () => {});
		if (options.stdin !== undefined) {
			child.stdin?.write(options.stdin);
		}
		child.stdin?.end();
	});
}

/**
 * stderr patterns that prove a 255 came from the transport. An unrecognised 255 is
 * left alone, because a remote command is allowed to exit 255 as well: claiming
 * otherwise would tell the model to reconnect when its command simply failed.
 */
const TRANSPORT_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
	[/passphrase required|entered in batch mode|too many authentication failures|permission denied/i, "refused to authenticate (BatchMode is on, so ssh could not ask for a passphrase: add the key to ssh-agent)"],
	[/host key verification failed|identification has changed|no matching host key|no matching key exchange/i, "rejected the host key"],
	[/could not resolve hostname|name or service not known|temporary failure in name resolution/i, "did not resolve"],
	[/connection timed out|operation timed out/i, "did not answer within the connect timeout"],
	[/connection refused|no route to host|network is unreachable|connection closed by/i, "could not be connected to"],
	[/connection reset by|broken pipe|timeout, server|client loop exited/i, "dropped"],
];

/** Why a call never reached the remote shell, or null when stderr says nothing. */
function sshTransportFailure(stderr: string): string | null {
	if (!stderr.trim()) {
		return null;
	}
	for (const [pattern, reason] of TRANSPORT_FAILURES) {
		if (pattern.test(stderr)) {
			return reason;
		}
	}
	return null;
}

async function sshOk(remote: string, command: string, options: SshExecOptions = {}): Promise<Buffer> {
	const { stdout, stderr, exitCode } = await sshExec(remote, command, options);
	if (exitCode !== 0) {
		const errorText = stderr.toString("utf8").trim() || stdout.toString("utf8").trim() || "unknown ssh error";
		const transport = exitCode === SSH_TRANSPORT_EXIT_CODE ? sshTransportFailure(stderr.toString("utf8")) : null;
		throw new Error(
			transport
				? `SSH to ${remote} ${transport} - the command did not run: ${errorText}`
				: `SSH failed (${exitCode}): ${errorText}`,
		);
	}
	return stdout;
}

async function resolveRemoteCwd(profile: SshProfile): Promise<string> {
	if (profile.cwd?.trim()) {
		return profile.cwd.trim();
	}
	// /ssh <host> awaits this with nothing to cancel it, so it cannot be allowed to wait forever.
	return (await sshOk(profile.remote, "pwd", { timeoutSeconds: SSH_CONTROL_TIMEOUT_SECONDS })).toString("utf8").trim();
}

/**
 * `test -r` reports a missing file with an exit code and not a word, which is how every
 * unreadable remote file used to arrive as "SSH failed (1): unknown ssh error". Name the
 * check that failed and the path it failed on, so the model can create the file, fix its
 * permissions, or correct the path without involving the user.
 */
function remoteAccessCheck(path: string, requireWritable: boolean): string {
	const quoted = shellQuote(path);
	const report = (reason: string) => shellQuote(`${reason}: ${path}`);
	return [
		`if [ ! -e ${quoted} ]; then echo ${report("no such file")} >&2; exit 1; fi`,
		`if [ ! -f ${quoted} ]; then echo ${report("not a regular file")} >&2; exit 1; fi`,
		`if [ ! -r ${quoted} ]; then echo ${report("not readable")} >&2; exit 1; fi`,
		...(requireWritable ? [`if [ ! -w ${quoted} ]; then echo ${report("not writable")} >&2; exit 1; fi`] : []),
	].join("; ");
}

/**
 * The signal is the tool call's own, so Esc ends a remote read instead of only a bash one.
 *
 * pi checks a file before it asks whether that file is an image, so the check also brings back
 * the sniff window: magic bytes then cost no extra round trip, and an extension lies both ways -
 * a PNG named `.dat` used to arrive as pages of binary text, a text file named `.png` as an
 * attachment nothing could decode. The map lives for one tool call, so an answer cannot outlive
 * the read it was taken for.
 */
function createRemoteReadOps(target: ActiveSshTarget, signal?: AbortSignal): ReadOperations {
	const sniffed = new Map<string, string | null>();
	const headCommand = (path: string) => `head -c ${IMAGE_SNIFF_BYTES} ${shellQuote(path)}`;
	return {
		readFile: (absolutePath) => sshOk(target.remote, `cat ${shellQuote(absolutePath)}`, { signal }),
		access: async (absolutePath) => {
			// The checks exit the remote shell on the first failure, so `head` only runs on a file
			// that is really there and really readable.
			const head = await sshOk(target.remote, `${remoteAccessCheck(absolutePath, false)}; ${headCommand(absolutePath)}`, { signal });
			sniffed.set(absolutePath, sniffImageMimeType(head));
		},
		detectImageMimeType: async (absolutePath) => {
			const cached = sniffed.get(absolutePath);
			if (cached !== undefined) {
				sniffed.delete(absolutePath);
				return cached;
			}
			return sniffImageMimeType(await sshOk(target.remote, headCommand(absolutePath), { signal }));
		},
	};
}

function createRemoteWriteOps(target: ActiveSshTarget, signal?: AbortSignal): WriteOperations {
	return {
		writeFile: async (absolutePath, content) => {
			await sshOk(target.remote, `cat > ${shellQuote(absolutePath)}`, { stdin: content, signal });
		},
		mkdir: (dir) => sshOk(target.remote, `mkdir -p ${shellQuote(dir)}`, { signal }).then(() => {}),
	};
}

/**
 * The edit tool is built on the remote cwd, so every absolute path it hands these operations is
 * already a remote path: nothing is translated, and no local directory enters the picture.
 */
function createRemoteEditOps(target: ActiveSshTarget, signal?: AbortSignal): EditOperations {
	return {
		readFile: (absolutePath) => sshOk(target.remote, `cat ${shellQuote(absolutePath)}`, { signal }),
		writeFile: async (absolutePath, content) => {
			await sshOk(target.remote, `cat > ${shellQuote(absolutePath)}`, {
				stdin: content,
				signal,
			});
		},
		access: (absolutePath) => sshOk(target.remote, remoteAccessCheck(absolutePath, true), { signal }).then(() => {}),
	};
}

/**
 * The diff an `ssh_edit` call would produce, or the reason it could not be computed. The same
 * shape pi's own edit preview has, so the renderer treats a preview and a result alike.
 */
type SshEditPreview = { diff: string; firstChangedLine?: number } | { error: string };

/**
 * pi's edit renderer keeps its preview bookkeeping on the Box it draws, and the tool row hands
 * that Box back through `context.lastComponent`. The remote renderer keeps the same fields, so
 * the frame, the streaming preview, and the settled diff all update one component.
 */
type SshEditCallComponent = Box & {
	preview?: SshEditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

/** The part of pi's tool render context this renderer reads; `ToolRenderContext` is not exported. */
type SshEditRenderContext = {
	args: unknown;
	invalidate: () => void;
	lastComponent: unknown;
	state: { callComponent?: SshEditCallComponent };
	executionStarted: boolean;
	argsComplete: boolean;
	isError: boolean;
	outputPad: number;
};

/** The part of pi's tool result this renderer reads. */
type SshEditToolResult = {
	content: { type: string; text?: string }[];
	details?: unknown;
};

type SshEditInput = { path: string; edits: { oldText: string; newText: string }[] };

/**
 * The edit arguments a diff can be computed from, accepting every shape pi accepts: the
 * `edits[]` array, the legacy single `oldText`/`newText` pair, and `file_path`.
 */
function getRenderableEditInput(args: unknown): SshEditInput | null {
	const value = args as { path?: unknown; file_path?: unknown; edits?: unknown; oldText?: unknown; newText?: unknown } | undefined;
	if (!value) {
		return null;
	}
	const path = typeof value.path === "string" ? value.path : typeof value.file_path === "string" ? value.file_path : null;
	if (!path) {
		return null;
	}
	if (
		Array.isArray(value.edits) &&
		value.edits.length > 0 &&
		value.edits.every((edit) => {
			const entry = edit as { oldText?: unknown; newText?: unknown } | null;
			return typeof entry?.oldText === "string" && typeof entry?.newText === "string";
		})
	) {
		return { path, edits: value.edits as SshEditInput["edits"] };
	}
	if (typeof value.oldText === "string" && typeof value.newText === "string") {
		return { path, edits: [{ oldText: value.oldText, newText: value.newText }] };
	}
	return null;
}

/** The key pi's edit preview uses to decide whether the arguments moved. Host is left out on purpose: a
 *  settled row keeps its diff when `/ssh off` later changes the label next to it. */
function editPreviewArgsKey(input: SshEditInput | null): string | undefined {
	return input ? JSON.stringify({ path: input.path, edits: input.edits }) : undefined;
}

/**
 * The diff an `ssh_edit` call would produce, without writing to the host.
 *
 * pi previews a local edit by reading the file off disk; the pre-edit bytes of a remote edit
 * only exist on the host, so the preview pays for the one `cat` that read would have been. The
 * diff itself comes from pi's own edit tool run with write operations that capture instead of
 * upload, so the preview cannot drift from the real call: BOM, line endings, and fuzzy matching
 * all stay pi's code.
 */
async function computeRemoteEditPreview(target: ActiveSshTarget, input: SshEditInput): Promise<SshEditPreview> {
	try {
		// Same tool, same cwd, same path maths as the real call, so the file the preview reads is
		// the file the edit will write. Only the upload is swapped for a no-op, and the existence
		// check is dropped: `cat` fails on its own, and the check would be a second round trip.
		const path = await expandRemoteTilde("ssh_edit", input.path, target);
		const operations = createRemoteEditOps(target);
		const tool = createEditToolDefinition(target.remoteCwd, {
			operations: { access: async () => {}, readFile: operations.readFile, writeFile: async () => {} },
		});
		const result = await tool.execute(
			"ssh_edit_preview",
			{ path, edits: input.edits },
			undefined,
			undefined,
			{ cwd: target.remoteCwd } as unknown as Parameters<typeof tool.execute>[4],
		);
		const details = result.details as EditToolDetails | undefined;
		if (typeof details?.diff !== "string") {
			return { error: `Could not preview the remote edit of ${input.path}.` };
		}
		return { diff: details.diff, firstChangedLine: details.firstChangedLine };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function getEditHeaderBg(preview: SshEditPreview | undefined, settledError: boolean | undefined, theme: Theme): (text: string) => string {
	if (preview) {
		return "error" in preview ? (text) => theme.bg("toolErrorBg", text) : (text) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text) => theme.bg("toolErrorBg", text);
	}
	return (text) => theme.bg("toolPendingBg", text);
}

/** Reuse the Box this row drew before, so a streaming call repaints one component instead of allocating per frame. */
function getSshEditCallComponent(context: SshEditRenderContext): SshEditCallComponent {
	if (context.lastComponent instanceof Box) {
		const component = context.lastComponent as SshEditCallComponent;
		context.state.callComponent = component;
		return component;
	}
	if (context.state.callComponent) {
		return context.state.callComponent;
	}
	const component: SshEditCallComponent = Object.assign(new Box(1, 1, (text) => text), {
		preview: undefined,
		previewArgsKey: undefined,
		previewPending: false,
		settledError: false,
	});
	context.state.callComponent = component;
	return component;
}

/** Whether the framed body changed enough to redraw, with pi's own comparison. */
function setSshEditPreview(component: SshEditCallComponent, preview: SshEditPreview, argsKey: string | undefined): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

/**
 * Evidence for a failing renderer. pi catches anything a renderer throws and re-renders the row
 * with a bare Text; for a self-shell tool that fallback has no frame at all, so the row would
 * lose its background in complete silence. It goes to the same opt-in file as the call log: a
 * row that fails on every repaint would otherwise append to a file nobody asked for.
 */
function logSshEditRenderError(where: string, error: unknown): void {
	logSshCall(`${where}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}

/** The frame survives any renderer failure: the reason goes inside it instead of replacing it. */
function buildSshEditErrorFrame(theme: Theme, outputPad: number, error: unknown): Box {
	const component = new Box(1, 1, (text) => theme.bg("toolErrorBg", text));
	component.setPaddingX(outputPad);
	component.addChild(
		new Text(
			`${theme.fg("toolTitle", theme.bold("ssh_edit"))} ${theme.fg("error", error instanceof Error ? error.message : String(error))}`,
			0,
			0,
		),
	);
	return component;
}

function renderSshEditCall(args: unknown, theme: Theme, context: SshEditRenderContext, target: ActiveSshTarget | null): Component {
	try {
		return renderSshEditCallBody(args, theme, context, target);
	} catch (error) {
		logSshEditRenderError("renderCall", error);
		return buildSshEditErrorFrame(theme, context.outputPad, error);
	}
}

function renderSshEditResult(result: SshEditToolResult, theme: Theme, context: SshEditRenderContext, target: ActiveSshTarget | null): Container {
	try {
		return renderSshEditResultBody(result, theme, context, target);
	} catch (error) {
		logSshEditRenderError("renderResult", error);
		const component = new Container();
		component.addChild(new Text(theme.fg("error", error instanceof Error ? error.message : String(error)), context.outputPad, 0));
		return component;
	}
}

/** The framed row: the title line, then the diff or the reason there is none, all on the tool background. */
function buildSshEditCallComponent(
	component: SshEditCallComponent,
	args: unknown,
	theme: Theme,
	targetLabel: string,
	outputPad: number,
): SshEditCallComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.setPaddingX(outputPad);
	component.clear();
	const path = getRenderableEditInput(args)?.path ?? "...";
	component.addChild(
		new Text(
			`${theme.fg("toolTitle", theme.bold("ssh_edit"))} ${theme.fg("accent", path)} ${theme.fg("muted", `[${targetLabel}]`)}`,
			0,
			0,
		),
	);
	if (!component.preview) {
		return component;
	}
	const body = "error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function renderSshEditCallBody(args: unknown, theme: Theme, context: SshEditRenderContext, target: ActiveSshTarget | null): SshEditCallComponent {
	const component = getSshEditCallComponent(context);
	const input = getRenderableEditInput(args);
	const argsKey = editPreviewArgsKey(input);
	if (component.previewArgsKey !== argsKey) {
		component.preview = undefined;
		component.previewArgsKey = argsKey;
		component.previewPending = false;
		component.settledError = false;
	}
	// The preview is a remote read, so it runs once per argument set, only while the call is
	// still streaming (a settled row takes its diff from the result instead), only before the
	// call starts (the file changes under it), and only with a host to read from.
	if (context.argsComplete && !context.executionStarted && target && input && !component.preview && !component.previewPending) {
		component.previewPending = true;
		const requestKey = argsKey;
		void computeRemoteEditPreview(target, input).then((preview) => {
			if (component.previewArgsKey !== requestKey) {
				return;
			}
			if (setSshEditPreview(component, preview, requestKey)) {
				context.invalidate();
			}
		}).catch((error) => logSshEditRenderError("preview", error));
	}
	return buildSshEditCallComponent(component, args, theme, target ? target.name : "inactive", context.outputPad);
}

/**
 * The result row. The diff belongs inside the frame above, so this stays empty for a successful
 * call; only an error the preview did not already show gets a line of its own, and it sits
 * outside the frame exactly as pi's edit renderer leaves it.
 */
function renderSshEditResultBody(result: SshEditToolResult, theme: Theme, context: SshEditRenderContext, target: ActiveSshTarget | null): Container {
	const callComponent = context.state.callComponent;
	const argsKey = editPreviewArgsKey(getRenderableEditInput(context.args));
	const details = result.details as EditToolDetails | undefined;
	const resultDiff = context.isError ? undefined : details?.diff;
	let changed = false;
	if (callComponent) {
		if (typeof resultDiff === "string") {
			changed =
				setSshEditPreview(callComponent, { diff: resultDiff, firstChangedLine: details?.firstChangedLine }, argsKey) || changed;
		}
		if (callComponent.settledError !== context.isError) {
			callComponent.settledError = context.isError;
			changed = true;
		}
		if (changed) {
			buildSshEditCallComponent(callComponent, context.args, theme, target ? target.name : "inactive", context.outputPad);
		}
	}
	const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
	component.clear();
	const preview = callComponent?.preview;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	const errorText = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	if (context.isError && errorText && errorText !== previewError) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.fg("error", errorText), context.outputPad, 0));
	}
	return component;
}

/**
 * The `write` row previews the content it is about to put on disk: ten lines collapsed, all of it
 * after Ctrl+O. That preview is drawn by the call renderer, not the result renderer, so a tool that
 * replaces the call renderer has to draw it again - otherwise its row shows a title at every width
 * and Ctrl+O opens nothing.
 */
const SSH_WRITE_PREVIEW_LINES = 10;

type SshWriteCallComponent = Text & { preview?: { source: string; lang: string | undefined; lines: string[] } };
type SshWriteRenderContext = { lastComponent: unknown; expanded: boolean };

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end -= 1;
	}
	return lines.slice(0, end);
}

/** Highlighted once per content, then reused: a repaint of the same call must not re-run shiki. */
function sshWritePreviewLines(content: string, lang: string | undefined, component: SshWriteCallComponent): string[] {
	const cached = component.preview;
	if (cached && cached.source === content && cached.lang === lang) {
		return cached.lines;
	}
	const normalized = content.replace(/\r/g, "");
	const lines = trimTrailingEmptyLines(lang ? highlightCode(normalized, lang) : normalized.split("\n"));
	component.preview = { source: content, lang, lines };
	return lines;
}

function renderSshWriteCall(
	args: unknown,
	theme: Theme,
	context: SshWriteRenderContext,
	target: ActiveSshTarget | null,
): SshWriteCallComponent {
	const input = (args ?? {}) as { path?: unknown; content?: unknown };
	const path = typeof input.path === "string" ? input.path : "";
	const component = (
		context.lastComponent instanceof Text
			? (context.lastComponent as SshWriteCallComponent)
			: new Text("", 0, 0)
	) as SshWriteCallComponent;
	const title =
		`${theme.fg("toolTitle", theme.bold("ssh_write"))} ${theme.fg("accent", path || "...")} ` +
		theme.fg("muted", `[${target ? target.name : "inactive"}]`);
	// Same three cases the write row has: no content argument yet, empty content, real content.
	const content = input.content === undefined ? "" : typeof input.content === "string" ? input.content : null;
	if (content === null) {
		component.setText(`${title}\n\n${theme.fg("error", "[invalid content arg - expected string]")}`);
		return component;
	}
	if (!content) {
		component.setText(title);
		return component;
	}
	const lang = path ? getLanguageFromPath(path) : undefined;
	const lines = sshWritePreviewLines(content, lang, component);
	const shown = context.expanded ? lines.length : Math.min(lines.length, SSH_WRITE_PREVIEW_LINES);
	const body = lines
		.slice(0, shown)
		.map((line) => (lang ? line : theme.fg("toolOutput", line.replace(/\t/g, "   "))))
		.join("\n");
	const hidden = lines.length - shown;
	const hint = hidden > 0 ? `${theme.fg("muted", `\n... (${hidden} more lines, ${lines.length} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}` : "";
	component.setText(`${title}\n\n${body}${hint}`);
	return component;
}

function createRemoteBashOps(target: ActiveSshTarget, overrideCwd?: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const dir = overrideCwd ?? cwd;
			// `bash -s`, not `bash -se`: the local bash tool hands the command to `bash -c`, where a
			// `;` list carries on after a failing command and the exit code is the last command's.
			// The guard is the one thing -e was quietly doing - keeping a command out of the login
			// directory when the requested one is gone - said out loud instead of by side effect.
			const script =
				`cd ${shellQuote(dir)} || { echo ${shellQuote(`Cannot change to ${dir} on ${target.name} - the command did not run.`)} >&2; exit 1; }\n${command}\n`;
			const { exitCode, stderr } = await sshExec(target.remote, "exec bash -s", {
				stdin: script,
				signal,
				timeoutSeconds: timeout,
				onStdoutData: onData,
				onStderrData: onData,
			});
			// A dropped link would otherwise reach the model as a bare exit 255 that
			// reads like the command itself failed, so say what actually happened.
			const transport = exitCode === SSH_TRANSPORT_EXIT_CODE ? sshTransportFailure(stderr.toString("utf8")) : null;
			if (transport) {
				onData(
					Buffer.from(
						`\n[ssh-tools] SSH to ${target.remote} ${transport} - the command did not run. Reconnect with /ssh ${target.name}.\n`,
						"utf8",
					),
				);
			}
			return { exitCode };
		},
	};
}

/** Split the settings `shellCommandPrefix` pi prepends to `!` / `!!` commands from the command the user typed. */
function splitSettingsPrefix(command: string, prefix: string | undefined): { prefix: string; body: string } {
	if (prefix && command.startsWith(`${prefix}\n`)) {
		return { prefix: `${prefix}\n`, body: command.slice(prefix.length + 1) };
	}
	return { prefix: "", body: command };
}

/**
 * Operations for user-entered `!` and `!!` commands, used only while SSH mode is on.
 * They run on the active SSH host, and `local:` forces the local machine.
 */
function createUserBashOperations(
	target: ActiveSshTarget,
	settings: { shellCommandPrefix?: string; shellPath?: string },
): BashOperations {
	const settingsPrefix = settings.shellCommandPrefix || undefined;
	const remoteOps = createRemoteBashOps(target, target.remoteCwd);
	const localOps = createLocalBashOperations({ shellPath: settings.shellPath });
	return {
		exec: async (command, cwd, options) => {
			const { prefix, body } = splitSettingsPrefix(command, settingsPrefix);
			const trimmed = body.replace(/^[ \t]+/, "");
			if (!trimmed.startsWith(LOCAL_BASH_MARKER)) {
				return remoteOps.exec(body, cwd, options);
			}
			const localCommand = `${prefix}${trimmed.slice(LOCAL_BASH_MARKER.length).replace(/^[ \t]+/, "")}`;
			return localOps.exec(localCommand, cwd, options);
		},
	};
}

function enableSshTools(pi: ExtensionAPI) {
	const next = new Set(pi.getActiveTools());
	for (const name of SSH_TOOL_NAMES) {
		next.add(name);
	}
	pi.setActiveTools(Array.from(next));
}

function disableSshTools(pi: ExtensionAPI) {
	const next = pi.getActiveTools().filter((name) => !SSH_TOOL_NAMES.includes(name as (typeof SSH_TOOL_NAMES)[number]));
	pi.setActiveTools(next);
}

export default function sshToolsExtension(pi: ExtensionAPI) {
	let activeTarget: ActiveSshTarget | null = null;

	/** Kept after /ssh off so the recorded state still names a host to reconnect to. */
	let lastTarget: ActiveSshTarget | null = null;
	/** Last state written to the session file, so unchanged state is not appended twice. */
	let lastPersistedState: SshSessionState | null = null;
	/** What the session branch recorded last time we looked, so /tree only reacts to changes. */
	let lastRecordedState: SshSessionState | null = null;
	let stateOrigin: StateOrigin = "none";
	/** Bumped whenever the target changes, so a stale background probe stays quiet. */
	let probeToken = 0;

	const readBase = createReadToolDefinition("/");
	const writeBase = createWriteToolDefinition("/");
	const editBase = createEditToolDefinition("/");
	const bashBase = createBashToolDefinition("/");
	// Only the first sentence of each description is rewritten; see remoteToolDescription.
	const readDescription = remoteToolDescription(
		readBase.description,
		"Read the contents of a file on the active SSH host.",
		REMOTE_PATH_NOTE,
	);
	const writeDescription = remoteToolDescription(
		writeBase.description,
		"Write content to a file on the active SSH host.",
		REMOTE_PATH_NOTE,
	);
	const editDescription = remoteToolDescription(
		editBase.description,
		"Edit a single file on the active SSH host using exact text replacement.",
		REMOTE_PATH_NOTE,
	);
	const bashDescription = remoteToolDescription(
		bashBase.description,
		"Execute a bash command on the active SSH host in the active remote working directory.",
	);

	const requireActiveTarget = (): ActiveSshTarget => {
		if (!activeTarget) {
			throw new Error("SSH mode is off. Use /ssh <host> first.");
		}
		return activeTarget;
	};

	const refreshProfiles = () => parseSshConfigProfiles();

	const updateStatus = (ctx: ExtensionContext) => {
		if (!activeTarget) {
			ctx.ui.setStatus(SSH_STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(
			SSH_STATUS_KEY,
			ctx.ui.theme.fg("accent", `SSH ${activeTarget.name}:${activeTarget.remoteCwd}`),
		);
	};

	// A restored workspace is state, not news. notify() appends a dim line to the chat,
	// which the transcript then pushes up and out of sight - precisely when the user stops
	// seeing it and still needs to know which machine `!` will hit. The widget above the
	// editor belongs to the live layout, so it stays until the first interaction; after
	// that the footer and the per-turn system prompt carry the host.
	let noticeShown = false;

	const showWorkspaceNotice = (ctx: ExtensionContext, state: SshSessionState, origin: StateOrigin) => {
		ctx.ui.setWidget(
			SSH_NOTICE_KEY,
			[
				ctx.ui.theme.fg("accent", `SSH ${state.name}  ${state.remoteCwd}`),
				ctx.ui.theme.fg(
					"muted",
					`${STATE_ORIGIN_NOTES[origin]} · ! and !! run remotely · prefix local: for local`,
				),
			],
			{ placement: "aboveEditor" },
		);
		noticeShown = true;
	};

	const hideWorkspaceNotice = (ctx: ExtensionContext) => {
		if (!noticeShown) {
			return;
		}
		noticeShown = false;
		ctx.ui.setWidget(SSH_NOTICE_KEY, undefined);
	};

	// One entry per change keeps the newest copy next to the leaf: /resume reads the
	// newest match back, /fork and /clone copy the whole branch, and a crash before
	// session_shutdown cannot lose the workspace. No entry renderer is registered, so
	// the transcript stays clean and only /tree shows the raw custom type.
	const snapshotState = (): SshSessionState | null => {
		const target = activeTarget ?? lastTarget;
		if (!target) {
			return null;
		}
		return {
			version: SESSION_STATE_VERSION,
			active: activeTarget !== null,
			name: target.name,
			remote: target.remote,
			remoteCwd: target.remoteCwd,
		};
	};

	const persistState = () => {
		const state = snapshotState();
		if (!state || sameSessionState(lastPersistedState, state)) {
			return;
		}
		try {
			pi.appendEntry(SESSION_STATE_ENTRY_TYPE, state);
			lastPersistedState = state;
			lastRecordedState = state;
		} catch (error) {
			console.warn("[pi-ssh-tools] could not record the SSH workspace in this session:", error);
		}
	};

	/** Apply a recorded workspace. Returns whether SSH mode ended up active. */
	const applyState = (state: SshSessionState, origin: StateOrigin): boolean => {
		const target: ActiveSshTarget = {
			name: state.name,
			remote: state.remote,
			remoteCwd: state.remoteCwd,
		};
		lastTarget = target;
		stateOrigin = origin;
		if (!state.active) {
			activeTarget = null;
			probeToken += 1;
			disableSshTools(pi);
			return false;
		}
		activeTarget = target;
		enableSshTools(pi);
		return true;
	};

	// Reachability is checked after the session is up: pi awaits session_start, and an
	// unreachable host must not delay or block startup. The workspace stays restored -
	// this only explains why the next ssh_* call may fail.
	const probeWorkspace = (target: ActiveSshTarget, ctx: ExtensionContext) => {
		const token = ++probeToken;
		const warn = (message: string) => {
			try {
				ctx.ui.notify(message, "warning");
			} catch {
				// The session was replaced under this probe; the new one reports its own state.
			}
		};
		void sshExec(target.remote, "true", {
			timeoutSeconds: PROBE_TIMEOUT_SECONDS,
			connectTimeoutSeconds: PROBE_TIMEOUT_SECONDS,
		})
			.then(({ exitCode, stderr }) => {
				if (token !== probeToken || activeTarget?.remote !== target.remote || exitCode === 0) {
					return;
				}
				const stderrText = stderr.toString("utf8");
				const detail = summarizeError(stderrText);
				const reason = sshTransportFailure(stderrText) ?? `did not answer (exit ${exitCode})`;
				warn(
					`SSH workspace ${target.name} (${target.remote}) is restored, but the host ${reason}${detail ? `: ${detail}` : ""}. Run /ssh status.`,
				);
			})
			.catch((error: unknown) => {
				if (token !== probeToken || activeTarget?.remote !== target.remote) {
					return;
				}
				const message = summarizeError(error);
				const reason = message.startsWith("timeout:")
					? `no answer within ${PROBE_TIMEOUT_SECONDS}s`
					: message || "unknown error";
				warn(`SSH workspace ${target.name} (${target.remote}) is restored, but the host is not reachable (${reason}). Run /ssh status.`);
			});
	};

	const activate = async (profile: SshProfile, ctx: ExtensionCommandContext) => {
		const remoteCwd = await resolveRemoteCwd(profile);
		activeTarget = { name: profile.name, remote: profile.remote, remoteCwd };
		lastTarget = activeTarget;
		stateOrigin = "manual";
		probeToken += 1;
		enableSshTools(pi);
		updateStatus(ctx);
		persistState();
		// A restored workspace the user just replaced by hand no longer needs reminding.
		hideWorkspaceNotice(ctx);
		ctx.ui.notify(
			`SSH mode on: ${activeTarget.name} (${activeTarget.remoteCwd}). ! and !! run remotely; prefix a command with local: to run it locally.`,
			"info",
		);
	};

	const deactivate = (ctx: ExtensionCommandContext) => {
		activeTarget = null;
		stateOrigin = "manual";
		probeToken += 1;
		disableSshTools(pi);
		updateStatus(ctx);
		hideWorkspaceNotice(ctx);
		persistState();
		ctx.ui.notify("SSH mode off", "info");
	};

	pi.registerTool({
		name: "ssh_read",
		label: "ssh_read",
		description: readDescription,
		promptSnippet: "Read file contents on the active SSH host",
		promptGuidelines: [
			"Use ssh_read when the task is on the active SSH host instead of the local machine.",
			"Use ssh_read to examine a remote file instead of cat or sed through ssh_bash.",
		],
		parameters: readBase.parameters,
		outputSchema: readBase.outputSchema,
		constrainedSampling: readBase.constrainedSampling,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const path = await expandRemoteTilde("ssh_read", params.path, target);
			const tool = createReadToolDefinition(target.remoteCwd, { operations: createRemoteReadOps(target, signal) });
			return tool.execute(toolCallId, { ...params, path }, signal, onUpdate, withCwd(ctx, target.remoteCwd));
		},
		renderCall(args, theme) {
			const path = typeof args?.path === "string" ? args.path : "...";
			const range = formatReadLineRange(args?.offset, args?.limit);
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ssh_read"))} ${theme.fg("accent", path)}` +
					(range ? theme.fg("warning", range) : "") +
					` ${theme.fg("muted", `[${targetLabel}]`)}`,
				0,
				0,
			);
		},
		renderResult: readBase.renderResult,
	});

	pi.registerTool({
		name: "ssh_write",
		label: "ssh_write",
		description: writeDescription,
		promptSnippet: "Create or overwrite files on the active SSH host",
		promptGuidelines: ["Use ssh_write only for new files or full rewrites on the active SSH host."],
		parameters: writeBase.parameters,
		constrainedSampling: writeBase.constrainedSampling,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const path = await expandRemoteTilde("ssh_write", params.path, target);
			const tool = createWriteToolDefinition(target.remoteCwd, { operations: createRemoteWriteOps(target, signal) });
			return tool.execute(toolCallId, { ...params, path }, signal, onUpdate, withCwd(ctx, target.remoteCwd));
		},
		renderCall(args, theme, context) {
			return renderSshWriteCall(args, theme, context as unknown as SshWriteRenderContext, activeTarget);
		},
		renderResult: writeBase.renderResult,
	});

	pi.registerTool({
		name: "ssh_edit",
		label: "ssh_edit",
		description: editDescription,
		promptSnippet: "Make precise file edits on the active SSH host, including several disjoint edits in one call",
		promptGuidelines: [
			"Use ssh_edit for precise remote changes (edits[].oldText must match exactly).",
			"When changing multiple separate locations in one remote file, use one ssh_edit call with several entries in edits[] instead of several ssh_edit calls.",
			"Each edits[].oldText is matched against the original remote file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the remote file. Do not pad with large unchanged regions.",
		],
		parameters: editBase.parameters,
		constrainedSampling: editBase.constrainedSampling,
		renderShell: editBase.renderShell,
		prepareArguments: editBase.prepareArguments,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			// Built on the remote cwd, like ssh_read and ssh_write: the same resolution pi applies to
			// both, so a path is accepted by all three file tools or refused by all three, and the
			// row, the diff headers, and the reply all name the file the way the call asked for it.
			const path = await expandRemoteTilde("ssh_edit", params.path, target);
			const tool = createEditToolDefinition(target.remoteCwd, { operations: createRemoteEditOps(target, signal) });
			return tool.execute(toolCallId, { ...params, path }, signal, onUpdate, withCwd(ctx, target.remoteCwd));
		},
		// pi's edit tool draws its own frame (`renderShell: "self"`), so this one has to as well:
		// a bare Text here would leave the row with neither the default shell's background nor its own.
		renderCall(args, theme, context) {
			return renderSshEditCall(args, theme, context as unknown as SshEditRenderContext, activeTarget);
		},
		renderResult(result, _options, theme, context) {
			return renderSshEditResult(result as unknown as SshEditToolResult, theme, context as unknown as SshEditRenderContext, activeTarget);
		},
	});

	pi.registerTool({
		name: "ssh_bash",
		label: "ssh_bash",
		description: bashDescription,
		promptSnippet: "Execute bash commands on the active SSH host",
		promptGuidelines: ["Use ssh_bash when the command must run on the active SSH host rather than locally."],
		parameters: bashBase.parameters,
		outputSchema: bashBase.outputSchema,
		constrainedSampling: bashBase.constrainedSampling,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const tool = createBashToolDefinition(target.remoteCwd, { operations: createRemoteBashOps(target) });
			return tool.execute(toolCallId, params, signal, onUpdate, withCwd(ctx, target.remoteCwd));
		},
		renderCall(args, theme, context) {
			startToolTimer(context);
			const command = typeof args?.command === "string" ? args.command : "...";
			const timeout = typeof args?.timeout === "number" && args.timeout > 0 ? args.timeout : undefined;
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("ssh_bash"))} ${theme.fg("accent", command)}` +
					(timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "") +
					` ${theme.fg("muted", `[${targetLabel}]`)}`,
			);
			return text;
		},
		renderResult: bashBase.renderResult,
	});

	// Route user-entered `!` and `!!` commands to the active SSH host. With SSH mode off this handler only points out a stray `local:` marker and returns undefined, so pi executes locally as usual.
	pi.on("user_bash", (event, ctx) => {
		hideWorkspaceNotice(ctx);
		if (!activeTarget) {
			if (event.command.replace(/^[ \t]+/, "").startsWith(LOCAL_BASH_MARKER)) {
				ctx.ui.notify("SSH mode is off - local: is not needed here and reaches your shell as a command name", "warning");
			}
			return undefined;
		}
		const settings = (pi.getSettings?.() ?? {}) as Partial<{ shellCommandPrefix: string; shellPath: string }>;
		return {
			operations: createUserBashOperations(activeTarget, {
				shellCommandPrefix: settings.shellCommandPrefix,
				shellPath: settings.shellPath,
			}),
		};
	});

	pi.registerCommand("ssh", {
		description: "Toggle remote SSH tools: /ssh, /ssh off, /ssh status, /ssh <host>[:/path]",
		getArgumentCompletions: (prefix) => {
			const options = ["off", "status", ...refreshProfiles().map((profile) => profile.name)];
			const filtered = options.filter((option) => option.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			const profiles = refreshProfiles();

			if (input === "status") {
				const gateNote = PERMISSION_GATE_NOTES[permissionGateState];
				if (!activeTarget) {
					ctx.ui.notify(`SSH mode is off. ${gateNote}.`, "info");
					return;
				}
				ctx.ui.notify(
					`SSH mode: ${activeTarget.name} (${activeTarget.remote}:${activeTarget.remoteCwd}) - ${STATE_ORIGIN_NOTES[stateOrigin]}. ${gateNote}.`,
					"info",
				);
				return;
			}

			if (input === "off") {
				if (!activeTarget) {
					ctx.ui.notify("SSH mode is already off", "info");
					return;
				}
				deactivate(ctx);
				return;
			}

			if (!input) {
				if (profiles.length === 0) {
					ctx.ui.notify("No SSH hosts found in ~/.ssh/config. Use /ssh <host>[:/path]", "warning");
					return;
				}
				const items = [...(activeTarget ? ["off"] : []), ...profiles.map((profile) => profile.name)];
				const picked = await ctx.ui.select("SSH target", items);
				if (!picked) {
					return;
				}
				if (picked === "off") {
					deactivate(ctx);
					return;
				}
				await activate(normalizeTargetArg(picked, profiles), ctx);
				return;
			}

			await activate(normalizeTargetArg(input, profiles), ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		// /fork and /clone copy the whole branch, so their entries already carry the
		// workspace and /resume reads the historical file; only /new and /reload start
		// from an empty branch and fall back to the in-process handoff slot.
		const recorded = findSessionState(ctx.sessionManager.getBranch());
		const startsEmpty = event.reason === "new" || event.reason === "reload" || event.reason === "fork";
		const handed = startsEmpty ? readHandoff(ctx.cwd) : null;
		// A handoff carries a live workspace, and only a live one. `/ssh off` closes a workspace for
		// good: its record stays in the session file that recorded it, where /resume and /fork read
		// it back, and passing an off record to the next session would bind that one, and every one
		// after it, to a host nobody has open. This clears a slot an older version left behind.
		if (handed && !handed.active) {
			writeHandoff(ctx.cwd, null);
		}
		const inherited = recorded ?? (handed?.active ? handed : null);

		// Whatever notice the previous session put up is about a workspace this session
		// has not looked at yet.
		hideWorkspaceNotice(ctx);

		if (!inherited) {
			activeTarget = null;
			lastTarget = null;
			lastPersistedState = null;
			lastRecordedState = null;
			stateOrigin = "none";
			disableSshTools(pi);
			updateStatus(ctx);
			return;
		}

		// Already on this branch (fork, clone, resume) means nothing to write; otherwise
		// the restored workspace lands in this session's own file right away.
		lastPersistedState = recorded ? inherited : null;
		lastRecordedState = recorded;
		const active = applyState(inherited, recorded ? "session" : "handoff");
		updateStatus(ctx);
		persistState();

		if (!active) {
			// The user turned SSH off on purpose; a later session must not resurrect it.
			ctx.ui.notify(
				`SSH mode stays off (${inherited.name}:${inherited.remoteCwd}) - /ssh ${inherited.name} reconnects`,
				"info",
			);
			return;
		}
		showWorkspaceNotice(ctx, inherited, recorded ? "session" : "handoff");
		probeWorkspace({ name: inherited.name, remote: inherited.remote, remoteCwd: inherited.remoteCwd }, ctx);
	});

	// /tree moves the leaf, and with it the newest recorded workspace. A branch that carries no
	// record of its own keeps the live one: the entry the last /ssh wrote sits after the leaf the
	// moment you step back, so "nothing recorded here" is what one node back looks like, not a
	// request to drop the connection. A branch that does carry a record decides for itself.
	pi.on("session_tree", async (_event, ctx) => {
		const recorded = findSessionState(ctx.sessionManager.getBranch());
		const inherited = recorded ?? snapshotState();
		if (!inherited) {
			// Neither this branch nor this process knows a workspace: nothing to report about it.
			return;
		}
		// Compared against what the branch we left recorded, so walking around a session that
		// never used SSH, or re-picking a point that changes nothing, stays quiet.
		const changed = !sameSessionState(lastRecordedState, inherited);
		const wasActive = Boolean(activeTarget);
		lastRecordedState = inherited;
		// What this branch holds itself, so carrying a workspace over writes it down once here
		// and the branch owns it from now on - a later /resume of this file finds it again.
		lastPersistedState = recorded;
		if (inherited.active) {
			applyState(inherited, recorded ? "session" : "carried");
			updateStatus(ctx);
			persistState();
			if (changed) {
				showWorkspaceNotice(ctx, inherited, recorded ? "session" : "carried");
				probeWorkspace({ name: inherited.name, remote: inherited.remote, remoteCwd: inherited.remoteCwd }, ctx);
			}
			return;
		}
		// applyState, not a hand-rolled shutdown: the workspace that just went off must become
		// the one this process remembers, or the next /tree move reports the previous branch's
		// host and carries the wrong workspace forward.
		applyState(inherited, "none");
		hideWorkspaceNotice(ctx);
		updateStatus(ctx);
		if (changed) {
			ctx.ui.notify(`${wasActive ? "SSH mode off" : "SSH mode stays off"} - ${inherited.name} is not connected at this point`, "info");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// The notice above the editor covers the moment before the user acts. Once a turn
		// starts, the footer and the per-turn system prompt say the same thing.
		hideWorkspaceNotice(ctx);
		if (!activeTarget) {
			return;
		}
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\nSSH mode is active for this turn.\nRemote host: ${activeTarget.remote}\nRemote working directory: ${activeTarget.remoteCwd}\nUse ssh_read, ssh_write, ssh_edit, and ssh_bash for remote work. Local read/write/edit/bash still operate on the local machine.\nBash commands the user runs with ! or !! also execute on the remote host in the remote working directory, unless the command starts with "local:".`,
		};
	});

	// ── pi-permission-system integration ─────────────────────────────────────
	// ssh_* paths are REMOTE paths, but pi-permission-system extracts `input.path`
	// from every extension tool by convention and judges it against the LOCAL
	// filesystem: a remote /etc/nginx/nginx.conf raises an external_directory ask,
	// and a remote .env hits a local `path` deny rule. Registering an extractor
	// that declines (returns undefined) makes both path gates see no path fact and
	// skip these tools entirely; the per-tool gate then decides on the tool name.
	// ssh_bash needs none: its input carries `command`, not `path`.
	// Remote access stays governed by the SSH target the user picked, not by
	// rules written for local files - and ssh_bash can already reach any remote
	// path, so a local path rule here would only be a false guarantee.
	let permissionGateState: PermissionGateState = "pending";
	let integrationAttempted = false;
	const extractorDisposers = new Map<string, () => void>();

	const registerPathBlindExtractors = (sessionId: string) => {
		// Set before any work: `permissions:ready` fires at least twice per node
		// (session_start, then the first before_agent_start) and a second
		// registration for the same tool name throws.
		integrationAttempted = true;
		const services = (globalThis as Record<symbol, unknown>)[PERMISSION_SERVICES_KEY] as Map<string, PermissionPathGateRegistrar> | undefined;
		const permissions = services?.get(sessionId);
		if (typeof permissions?.registerToolAccessExtractor !== "function") {
			permissionGateState = "missing";
			console.warn("[pi-ssh-tools] pi-permission-system published no service for this session, so its local path gates will keep judging remote paths.");
			return;
		}
		let registered = 0;
		for (const toolName of PATH_GATED_SSH_TOOLS) {
			try {
				const dispose = permissions.registerToolAccessExtractor(toolName, () => undefined);
				if (typeof dispose === "function") extractorDisposers.set(toolName, dispose);
				registered += 1;
			} catch (error) {
				// A duplicate means an earlier broadcast already landed a declining
				// extractor: same outcome, so count it as registered.
				if (String((error as Error)?.message ?? "").includes("already registered")) {
					registered += 1;
				} else {
					console.warn(`[pi-ssh-tools] could not register a declining path extractor for ${toolName}:`, error);
				}
			}
		}
		permissionGateState = registered > 0 ? "registered" : "missing";
	};

	// pi releases every tracked event-bus subscription when it invalidates this
	// runtime (session replacement or reload), so the subscription is not stored:
	// resetting the state below is enough to re-register on a fresh service.
	pi.events.on("permissions:ready", (data) => {
		if (integrationAttempted) return;
		const sessionId = (data as { sessionId?: string | null } | undefined)?.sessionId;
		// A null session id means the node published no keyed service; a later
		// broadcast may carry one, so do not mark the attempt as spent.
		if (!sessionId) return;
		registerPathBlindExtractors(sessionId);
	});

	pi.on("session_shutdown", (event, ctx) => {
		// The next session generation gets a fresh service whose registries are
		// empty, so release this node's registrations and arm the attempt again.
		for (const dispose of extractorDisposers.values()) {
			dispose();
		}
		extractorDisposers.clear();
		integrationAttempted = false;
		permissionGateState = "pending";

		// /new, /fork, and /reload can start from a file that does not carry our entry, so hand the
		// workspace to the next session in this process - a live one only. `/ssh off` closes a
		// workspace and ends its lifecycle there: the off record belongs to the session file that
		// recorded it, and an empty slot keeps /new from carrying one host into session after session.
		// /resume must not hand anything on: the historical session's own record decides there.
		// Quitting must not either - a new pi process starts with an empty slot, which keeps SSH mode
		// off after a restart.
		const carry = activeTarget !== null && (event.reason === "new" || event.reason === "fork" || event.reason === "reload");
		writeHandoff(ctx.cwd, carry ? snapshotState() : null);
	});
}
