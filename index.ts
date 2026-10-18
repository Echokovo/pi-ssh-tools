import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createLocalBashOperations,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type SshProfile = {
	name: string;
	remote: string;
	cwd?: string;
};

type ActiveSshTarget = {
	name: string;
	remote: string;
	remoteCwd: string;
};

type SshExecOptions = {
	stdin?: string | Buffer;
	signal?: AbortSignal;
	onStdoutData?: (data: Buffer) => void;
	onStderrData?: (data: Buffer) => void;
	timeoutSeconds?: number;
};

const SSH_STATUS_KEY = "ssh-tools";
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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizeRemoteDir(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function remoteRelativePath(path: string, remoteCwd: string): string {
	const normalizedCwd = normalizeRemoteDir(remoteCwd);
	if (path === normalizedCwd) {
		return ".";
	}
	if (!path.startsWith(`${normalizedCwd}/`)) {
		throw new Error(
			`Remote path ${path} is outside the active SSH working directory ${remoteCwd}. Use a relative path or switch SSH mode to that directory.`,
		);
	}
	return path.slice(normalizedCwd.length + 1);
}

function toLocalEditPath(path: string, remoteCwd: string): string {
	if (path.startsWith("~/")) {
		throw new Error("ssh_edit does not expand ~ paths. Use a path relative to the SSH working directory instead.");
	}
	if (isAbsolute(path)) {
		return remoteRelativePath(path, remoteCwd);
	}
	return path;
}

function toRemotePath(path: string, localCwd: string, remoteCwd: string): string {
	const relativePath = relative(localCwd, path).split(sep).join("/");
	if (relativePath.startsWith("../") || relativePath === "..") {
		throw new Error(`Resolved edit path ${path} escaped the local SSH edit workspace.`);
	}
	if (!relativePath || relativePath === ".") {
		return remoteCwd;
	}
	return `${normalizeRemoteDir(remoteCwd)}/${relativePath}`;
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

function inferImageMimeType(path: string): string | null {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return null;
	}
}

function sshExec(remote: string, command: string, options: SshExecOptions = {}) {
	return new Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }>((resolve, reject) => {
		const child = spawn("ssh", [remote, command], { stdio: ["pipe", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timedOut = false;
		const timer =
			typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
				? setTimeout(() => {
						timedOut = true;
						child.kill();
					}, options.timeoutSeconds * 1000)
				: undefined;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (options.signal) options.signal.removeEventListener("abort", onAbort);
		};

		const onAbort = () => {
			child.kill();
		};

		child.stdout.on("data", (data: Buffer) => {
			stdoutChunks.push(data);
			options.onStdoutData?.(data);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderrChunks.push(data);
			options.onStderrData?.(data);
		});
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (exitCode) => {
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
		});

		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		if (options.stdin !== undefined) {
			child.stdin.write(options.stdin);
		}
		child.stdin.end();
	});
}

async function sshOk(remote: string, command: string, options: SshExecOptions = {}): Promise<Buffer> {
	const { stdout, stderr, exitCode } = await sshExec(remote, command, options);
	if (exitCode !== 0) {
		const errorText = stderr.toString("utf8").trim() || stdout.toString("utf8").trim() || "unknown ssh error";
		throw new Error(`SSH failed (${exitCode}): ${errorText}`);
	}
	return stdout;
}

async function resolveRemoteCwd(profile: SshProfile): Promise<string> {
	if (profile.cwd?.trim()) {
		return profile.cwd.trim();
	}
	return (await sshOk(profile.remote, "pwd")).toString("utf8").trim();
}

function createRemoteReadOps(target: ActiveSshTarget): ReadOperations {
	return {
		readFile: (absolutePath) => sshOk(target.remote, `cat ${shellQuote(absolutePath)}`),
		access: (absolutePath) => sshOk(target.remote, `test -r ${shellQuote(absolutePath)}`).then(() => {}),
		detectImageMimeType: async (absolutePath) => inferImageMimeType(absolutePath),
	};
}

function createRemoteWriteOps(target: ActiveSshTarget): WriteOperations {
	return {
		writeFile: async (absolutePath, content) => {
			await sshOk(target.remote, `cat > ${shellQuote(absolutePath)}`, { stdin: content });
		},
		mkdir: (dir) => sshOk(target.remote, `mkdir -p ${shellQuote(dir)}`).then(() => {}),
	};
}

function createRemoteEditOps(target: ActiveSshTarget, localCwd: string): EditOperations {
	const remotePath = (path: string) => toRemotePath(path, localCwd, target.remoteCwd);
	return {
		readFile: (absolutePath) => sshOk(target.remote, `cat ${shellQuote(remotePath(absolutePath))}`),
		writeFile: async (absolutePath, content) => {
			await sshOk(target.remote, `cat > ${shellQuote(remotePath(absolutePath))}`, { stdin: content });
		},
		access: (absolutePath) => {
			const path = remotePath(absolutePath);
			return sshOk(target.remote, `test -r ${shellQuote(path)} && test -w ${shellQuote(path)}`).then(() => {});
		},
	};
}

function createRemoteBashOps(target: ActiveSshTarget, overrideCwd?: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const script = `cd ${shellQuote(overrideCwd ?? cwd)}\n${command}\n`;
			const { exitCode } = await sshExec(target.remote, "exec bash -se", {
				stdin: script,
				signal,
				timeoutSeconds: timeout,
				onStdoutData: onData,
				onStderrData: onData,
			});
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

	const readBase = createReadToolDefinition("/");
	const writeBase = createWriteToolDefinition("/");
	const editBase = createEditToolDefinition("/");
	const bashBase = createBashToolDefinition("/");

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

	const activate = async (profile: SshProfile, ctx: ExtensionCommandContext) => {
		const remoteCwd = await resolveRemoteCwd(profile);
		activeTarget = { name: profile.name, remote: profile.remote, remoteCwd };
		enableSshTools(pi);
		updateStatus(ctx);
		ctx.ui.notify(
			`SSH mode on: ${activeTarget.name} (${activeTarget.remoteCwd}). ! and !! run remotely; prefix a command with local: to run it locally.`,
			"info",
		);
	};

	const deactivate = (ctx: ExtensionCommandContext) => {
		activeTarget = null;
		disableSshTools(pi);
		updateStatus(ctx);
		ctx.ui.notify("SSH mode off", "info");
	};

	pi.registerTool({
		name: "ssh_read",
		label: "ssh_read",
		description: "Read a file on the active SSH host. Relative paths are resolved against the active remote working directory.",
		promptSnippet: "Read file contents on the active SSH host",
		promptGuidelines: ["Use ssh_read when the task is on the active SSH host instead of the local machine."],
		parameters: readBase.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const tool = createReadToolDefinition(target.remoteCwd, { operations: createRemoteReadOps(target) });
			return tool.execute(toolCallId, params, signal, onUpdate, withCwd(ctx, target.remoteCwd));
		},
		renderCall(args, theme) {
			const path = typeof args?.path === "string" ? args.path : "...";
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ssh_read"))} ${theme.fg("accent", path)} ${theme.fg("muted", `[${targetLabel}]`)}`,
				0,
				0,
			);
		},
		renderResult: readBase.renderResult,
	});

	pi.registerTool({
		name: "ssh_write",
		label: "ssh_write",
		description: "Write a text file on the active SSH host. Relative paths are resolved against the active remote working directory.",
		promptSnippet: "Create or overwrite files on the active SSH host",
		promptGuidelines: ["Use ssh_write only for new files or full rewrites on the active SSH host."],
		parameters: writeBase.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const tool = createWriteToolDefinition(target.remoteCwd, { operations: createRemoteWriteOps(target) });
			return tool.execute(toolCallId, params, signal, onUpdate, withCwd(ctx, target.remoteCwd));
		},
		renderCall(args, theme) {
			const path = typeof args?.path === "string" ? args.path : "...";
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ssh_write"))} ${theme.fg("accent", path)} ${theme.fg("muted", `[${targetLabel}]`)}`,
				0,
				0,
			);
		},
		renderResult: writeBase.renderResult,
	});

	pi.registerTool({
		name: "ssh_edit",
		label: "ssh_edit",
		description: "Edit a file on the active SSH host using exact text replacement. Relative paths are resolved against the active remote working directory.",
		promptSnippet: "Make precise file edits on the active SSH host",
		promptGuidelines: [
			"Use ssh_edit for precise remote changes.",
			"Each edits[].oldText must match exactly on the remote file.",
		],
		parameters: editBase.parameters,
		prepareArguments: editBase.prepareArguments,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const localCwd = process.cwd();
			const transformedParams = {
				...params,
				path: toLocalEditPath(params.path, target.remoteCwd),
			};
			const tool = createEditToolDefinition(localCwd, { operations: createRemoteEditOps(target, localCwd) });
			return tool.execute(toolCallId, transformedParams, signal, onUpdate, withCwd(ctx, localCwd));
		},
		renderCall(args, theme) {
			const path = typeof args?.path === "string" ? args.path : "...";
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ssh_edit"))} ${theme.fg("accent", path)} ${theme.fg("muted", `[${targetLabel}]`)}`,
				0,
				0,
			);
		},
		renderResult: editBase.renderResult,
	});

	pi.registerTool({
		name: "ssh_bash",
		label: "ssh_bash",
		description: "Execute a bash command on the active SSH host in the active remote working directory.",
		promptSnippet: "Execute bash commands on the active SSH host",
		promptGuidelines: ["Use ssh_bash when the command must run on the active SSH host rather than locally."],
		parameters: bashBase.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const tool = createBashToolDefinition(target.remoteCwd, { operations: createRemoteBashOps(target) });
			return tool.execute(toolCallId, params, signal, onUpdate, withCwd(ctx, target.remoteCwd));
		},
		renderCall(args, theme, context) {
			const command = typeof args?.command === "string" ? args.command : "...";
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("ssh_bash"))} ${theme.fg("accent", command)} ${theme.fg("muted", `[${targetLabel}]`)}`,
			);
			return text;
		},
		renderResult: bashBase.renderResult,
	});

	// Route user-entered `!` and `!!` commands to the active SSH host. With SSH mode off this handler only points out a stray `local:` marker and returns undefined, so pi executes locally as usual.
	pi.on("user_bash", (event, ctx) => {
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
				ctx.ui.notify(`SSH mode: ${activeTarget.name} (${activeTarget.remote}:${activeTarget.remoteCwd}). ${gateNote}.`, "info");
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

	pi.on("session_start", async (_event, ctx) => {
		activeTarget = null;
		disableSshTools(pi);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
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

	pi.on("session_shutdown", () => {
		// The next session generation gets a fresh service whose registries are
		// empty, so release this node's registrations and arm the attempt again.
		for (const dispose of extractorDisposers.values()) {
			dispose();
		}
		extractorDisposers.clear();
		integrationAttempted = false;
		permissionGateState = "pending";
	});
}
