import "./register.mjs";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

import { piImport } from "./resolve.mjs";

const FAKE_SSH_DIR = new URL("../fixtures", import.meta.url).pathname;

/** What one extension registration produced: the tools and commands it handed to pi. */
export type Captured = {
	tools: Map<string, any>;
	commands: Map<string, any>;
};

export type Workspace = {
	root: string;
	/** Stands in for the remote host's checkout. It is a real local path because the fake ssh runs the bytes here. */
	remote: string;
	/** The cwd pi itself was started in, i.e. where a local tool would work. */
	local: string;
	/** The remote user's home, as the fake ssh reports it. */
	home: string;
	sshLog: string;
};

/**
 * A file tree shared by both sides of every comparison. The same bytes go to the "remote" tree
 * and the local one, so a difference in what a tool reports cannot come from a difference in the
 * file it read.
 */
export const FILES: Record<string, string | Buffer> = {
	"notes.txt": "alpha\nbeta\ngamma\n",
	"crlf.txt": "a\r\nb\r\n",
	"bom.txt": "\uFE0Fx\ny\n",
	"empty.txt": "",
	"longline.txt": `${"z".repeat(60_000)}\n`,
	"many.txt": Array.from({ length: 3_000 }, (_, index) => `line ${index}`).join("\n"),
	"sub/nested.txt": "nested\n",
	// Images are named to disagree with their bytes on purpose: the point is which of the two the
	// tool believes.
	"pic.png": tinyPng(),
	"pic.dat": tinyPng(),
	"fake.png": "not an image at all\n",
	"anim.png": animatedPng(),
	"logo.bmp": tinyBmp(),
	"shot.jpg": tinyJpeg(),
	"clip.gif": Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000", "binary"),
	"wide.webp": Buffer.from("RIFF\u001a\u0000\u0000\u0000WEBPVP8 \u000e\u0000\u0000\u0000", "binary"),
	"sig.txt": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

function pngChunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function pngBody(): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr)]);
}

function tinyPng(): Buffer {
	return Buffer.concat([pngBody(), pngChunk("IDAT", Buffer.alloc(8)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** An animated png: pi refuses these, so the read has to come back as text on both sides. */
function animatedPng(): Buffer {
	return Buffer.concat([pngBody(), pngChunk("acTL", Buffer.alloc(6)), pngChunk("IDAT", Buffer.alloc(8)), pngChunk("IEND", Buffer.alloc(0))]);
}

function tinyBmp(): Buffer {
	const buffer = Buffer.alloc(60);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(60, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeUInt32LE(1, 18);
	buffer.writeUInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	return buffer;
}

function tinyJpeg(): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
}

export function createWorkspace(prefix = "pi-ssh-tools-"): Workspace {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const workspace = {
		root,
		remote: join(root, "remote", "proj"),
		local: join(root, "local", "proj"),
		home: join(root, "remote", "home"),
		sshLog: join(root, "ssh-calls.log"),
	};
	for (const dir of [workspace.remote, workspace.local, workspace.home]) {
		mkdirSync(dir, { recursive: true });
	}
	writeTree(workspace.remote);
	writeTree(workspace.local);
	writeTree(workspace.home, HOME_FILES);
	process.on("exit", () => rmSync(root, { recursive: true, force: true }));
	return workspace;
}

export function writeTree(root: string, files: Record<string, string | Buffer> = FILES): void {
	for (const [name, body] of Object.entries(files)) {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body);
	}
}

/** Put the tree back the way it was, so one case cannot leak into the next. */
export function resetTree(root: string, files: Record<string, string | Buffer> = FILES): void {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	writeTree(root, files);
}

/** The remote user's home, which both sides share because there is only one fake host. */
export const HOME_FILES: Record<string, string | Buffer> = { "notes.txt": "alpha\nbeta\ngamma\n" };

/**
 * Put every directory a case can touch back the way it was. The home directory needs this as much
 * as the two checkouts do: it is one directory serving both sides, so a case that edits it would
 * otherwise hand the second side a file the first side had already changed.
 */
export function resetWorkspace(workspace: Workspace): void {
	resetTree(workspace.remote);
	resetTree(workspace.local);
	resetTree(workspace.home, HOME_FILES);
}

/**
 * Point the extension at the fake host. This has to happen before the extension module is loaded:
 * the path of the ssh config it reads is fixed when the module is first evaluated, and the real
 * ~/.ssh/config belongs to whoever runs the tests, not to them.
 */
export function useFakeRemoteHost(workspace: Workspace): void {
	process.env.PATH = `${FAKE_SSH_DIR}:${process.env.PATH ?? ""}`;
	process.env.FAKE_REMOTE_HOME = workspace.home;
	process.env.FAKE_SSH_LOG = workspace.sshLog;
	process.env.HOME = join(workspace.root, "fakehome");
	mkdirSync(process.env.HOME, { recursive: true });
}

/** Load the extension the way pi does - as the default export handed an extension API. */
export async function loadExtension(): Promise<Captured> {
	const captured: Captured = { tools: new Map(), commands: new Map() };
	const noop = () => {};
	const extension = await import("../../index.ts");
	extension.default({
		registerTool: (definition: any) => captured.tools.set(definition.name, definition),
		registerCommand: (name: string, options: any) => captured.commands.set(name, options),
		registerShortcut: noop,
		on: noop,
		setActiveTools: noop,
		getActiveTools: () => [],
		getSettings: () => ({}),
		appendEntry: noop,
		events: { on: noop, emit: noop },
	} as any);
	return captured;
}

let themePromise: Promise<any> | undefined;

/** pi's theme, initialised, because the renderers colour their output through it. */
export function piTheme(): Promise<any> {
	initTheme("dark");
	themePromise ??= piImport("dist/modes/interactive/theme/theme.js").then((module) => module.theme);
	return themePromise;
}

/** Run the `/ssh` command, which is the only way the extension has of gaining or losing a target. */
export async function runSshCommand(captured: Captured, workspace: Workspace, input: string, cwd = workspace.local): Promise<void> {
	const theme = await piTheme();
	const noop = () => {};
	await captured.commands.get("ssh").handler(input, {
		cwd,
		hasUI: false,
		ui: {
			notify: noop,
			theme,
			setWidget: noop,
			setStatus: noop,
			setFooter: noop,
			setEditorText: noop,
			getEditorContent: () => "",
			on: () => noop,
			addAutocompleteProvider: noop,
			custom: () => undefined,
			select: async () => undefined,
		},
		abortController: new AbortController(),
		isIdle: () => true,
		model: { id: "test", provider: "test" },
	} as any);
}

export function activateSsh(captured: Captured, workspace: Workspace, cwd = workspace.local): Promise<void> {
	return runSshCommand(captured, workspace, `fakehost:${workspace.remote}`, cwd);
}

/** How many times the extension has talked to the host so far. */
export function sshCallCount(workspace: Workspace): number {
	try {
		return readFileSync(workspace.sshLog, "utf8").split("\n").filter((line) => line.length > 0).length;
	} catch {
		return 0;
	}

}

/**
 * An object that throws whatever is asked of it, for showing what a renderer does when it fails.
 * The marker has to come back in the message so a test can tell its own failure from an unrelated
 * one that happened to be logged by something else.
 */
export function hostile(marker: string): any {
	return new Proxy({ marker }, {
		get(target, property) {
			if (property === "marker") {
				return target.marker;
			}
			throw new Error(marker);
		},
	});
}

/** Where the extension writes its debug log when PI_SSH_TOOLS_DEBUG is set. */
export function debugLogPath(): string {
	return join(tmpdir(), "pi-ssh-tools.log");
}

/** pi's bash tool wants a session to name in the environment it hands the command. */
export const fakeSession = {
	getSessionId: () => "test-session",
	getSessionFile: () => undefined,
};

/** What a tool call left behind, in the form the model and pi's row would see it. */
export type Observed = {
	text?: string;
	isError?: boolean;
	details?: unknown;
	structured?: unknown;
	threw?: string;
};

export async function runTool(definition: any, params: unknown, cwd: string): Promise<Observed> {
	try {
		const result = await definition.execute("call-1", params, undefined, undefined, { cwd, sessionManager: fakeSession } as any);
		return {
			text: (result.content ?? [])
				.map((part: any) => (part.type === "text" ? part.text : `[${part.type} ${part.mimeType ?? ""} ${part.data?.length ?? 0}]`))
				.join("\n"),
			isError: result.isError === true,
			details: result.details ?? null,
			structured: result.structuredContent ?? null,
		};
	} catch (error) {
		return { threw: error instanceof Error ? error.message : String(error) };
	}
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Two results are comparable once the places that cannot match are blanked out: the two different
 * directories the same bytes live in, the fake home, the temp file a truncated output is saved to,
 * and anything measured in time.
 */
export function comparable(workspace: Workspace): (value: unknown) => string {
	const tempDir = escapeForRegExp(tmpdir());
	return (value: unknown) =>
		(JSON.stringify(value) ?? "null")
			.split(workspace.remote).join("<ROOT>")
			.split(workspace.local).join("<ROOT>")
			.split(workspace.home).join("<HOME>")
			.replace(new RegExp(`${tempDir}/[A-Za-z0-9._-]+`, "g"), "<TMP>")
			.replace(/("(?:[a-z]+_)?[a-z]*[Tt]ime[a-zA-Z]*)":\s*-?\d+(\.\d+)?/g, "$1:*");
}

/** One rendered row, driven through pi's own tool component the way an interactive session does. */
export async function toolRow(definition: any, args: unknown, result: unknown, cwd: string) {
	const { ToolExecutionComponent } = await piImport("dist/modes/interactive/components/tool-execution.js");
	const component = new ToolExecutionComponent(definition.name, "call-1", args, { outputPad: 1 }, definition, { requestRender: () => {} }, cwd);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult(result);
	return component;
}

const ANSI = /\u001b\[[0-9;]*m/g;
const OSC_LINK = /\u001b\]8;[^\u0007\u001b]*(\u0007|\u001b\\)/g;

/** The row as the user reads it: colours and file links gone, trailing blanks trimmed. */
export function rowText(component: any, width = 90): string[] {
	return component.render(width).map((line: string) => line.replace(ANSI, "").replace(OSC_LINK, "").trimEnd());
}

/** The row with its colours still on, for asserting which background a state paints. */
export function rowRaw(component: any, width = 90): string[] {
	return component.render(width);
}

/** Text as the user reads it, without colours or file links. */
export function plain(text: string): string {
	return text.replace(ANSI, "").replace(OSC_LINK, "");
}

export function textResult(text: string) {
	return { content: [{ type: "text", text }], details: undefined, isError: false, timestamp: 0 };
}

export function lines(count: number, tag: string): string {
	return Array.from({ length: count }, (_, index) => `${tag} ${index + 1}`).join("\n");
}

/** A render context like the one pi builds while a call streams in, before it has a result. */
export function callContext(overrides: Record<string, unknown> = {}) {
	const state: Record<string, unknown> = {};
	return {
		context: {
			args: {},
			toolCallId: "call-1",
			invalidate: () => {
				(state.invalidated as number | undefined) ??= 0;
				state.invalidated = (state.invalidated as number) + 1;
			},
			state,
			cwd: process.cwd(),
			executionStarted: false,
			argsComplete: true,
			isPartial: true,
			expanded: false,
			showImages: true,
			isError: false,
			durationMs: undefined,
			outputPad: 1,
			...overrides,
		},
		state,
	};
}

export const invalidateCount = (state: Record<string, unknown>): number => (state.invalidated as number | undefined) ?? 0;

/**
 * Give the extension somewhere private to write its debug log. The name of the file is fixed, so
 * two test files that run at the same time would otherwise read each other's entries.
 */
export function privateTmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	process.env.TMPDIR = dir;
	// Not registerCleanup: this directory is a parent of any workspace made after it, so it has to
	// go last, and only an exit hook runs after the workspaces have had their turn.
	process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * One session generation, as the session lifecycle handlers see it: what its branch carries, which
 * tools pi has active, and what the extension put in front of the user.
 */
export type LiveSession = {
	cwd: string;
	/** What `sessionManager.getBranch()` reports: the entries from the root to the current leaf. */
	branch: any[];
	tools: Map<string, any>;
	activeTools: string[];
	notices: Array<{ message: string; level: string | undefined }>;
	/** One row per `ui.setStatus` call, newest last; `undefined` is the row being cleared. */
	statuses: Array<string | undefined>;
	/** One row per `ui.setWidget` call, newest last; `undefined` lines are the widget being cleared. */
	widgets: Array<{ key: string; lines: string[] | undefined }>;
	commands: Map<string, any>;
};

/**
 * The extension held the way a running pi holds it: pi builds a new runtime for every session
 * generation, so each generation gets a fresh registration and only the session file and the
 * in-process handoff slot can cross from one to the next.
 */
export async function loadLivePi(): Promise<{
	start: (reason: string, options: { cwd: string; branch?: any[] }) => Promise<LiveSession>;
	shutdown: (session: LiveSession, reason: string) => Promise<void>;
	replace: (session: LiveSession, reason: "new" | "fork" | "resume") => Promise<LiveSession>;
	ssh: (session: LiveSession, input: string) => Promise<void>;
}> {
	const extension = await import("../../index.ts");
	const theme = await piTheme();
	const handlers = new Map<LiveSession, Map<string, Array<(event: any, ctx: any) => any>>>();

	const contextOf = (session: LiveSession) => ({
		cwd: session.cwd,
		hasUI: false,
		ui: {
			notify: (message: string, level?: string) => {
				session.notices.push({ message, level });
			},
			theme,
			setWidget: (key: string, lines: string[] | undefined) => {
				session.widgets.push({ key, lines });
			},
			setStatus: (_key: string, text: string | undefined) => {
				session.statuses.push(text);
			},
			setFooter: () => {},
			setEditorText: () => {},
			getEditorContent: () => "",
			on: () => () => {},
			addAutocompleteProvider: () => {},
			custom: () => undefined,
			select: async () => undefined,
		},
		sessionManager: {
			getBranch: () => session.branch,
			getSessionId: () => "live-session",
			getSessionFile: () => undefined,
		},
		abortController: new AbortController(),
		isIdle: () => true,
		model: { id: "test", provider: "test" },
	});

	const fire = async (session: LiveSession, type: string, event: any) => {
		for (const handler of handlers.get(session)?.get(type) ?? []) {
			await handler(event, contextOf(session));
		}
	};

	return {
		/**
		 * Register a fresh extension instance and announce the start. The branch stands for what the
		 * new session file carries, which is what separates `/fork` and `/resume` from `/new`.
		 */
		async start(reason, { cwd, branch = [] }) {
			const session: LiveSession = {
				cwd,
				branch,
				tools: new Map(),
				activeTools: [],
				notices: [],
				statuses: [],
				widgets: [],
				commands: new Map(),
			};
			const registry = new Map<string, Array<(event: any, ctx: any) => any>>();
			handlers.set(session, registry);
			extension.default({
				registerTool: (definition: any) => {
					session.tools.set(definition.name, definition);
				},
				registerCommand: (name: string, options: any) => {
					session.commands.set(name, options);
				},
				registerShortcut: () => {},
				on: (name: string, handler: (event: any, ctx: any) => any) => {
					const list = registry.get(name) ?? [];
					list.push(handler);
					registry.set(name, list);
				},
				setActiveTools: (tools: string[]) => {
					session.activeTools = [...tools];
				},
				getActiveTools: () => [...session.activeTools],
				getSettings: () => ({}),
				appendEntry: (customType: string, data: unknown) => {
					session.branch.push({ type: "custom", customType, data });
				},
				events: { on: () => () => {}, emit: () => {} },
			} as any);
			await fire(session, "session_start", { type: "session_start", reason });
			return session;
		},

		async shutdown(session, reason) {
			await fire(session, "session_shutdown", { type: "session_shutdown", reason });
		},

		/**
		 * Replace the session the way pi does: shut the current generation down, then start the next
		 * one. `/fork` and `/clone` copy the branch; `/new` and a fresh process start from none.
		 */
		async replace(session, reason) {
			await this.shutdown(session, reason);
			return this.start(reason, { cwd: session.cwd, branch: reason === "new" ? [] : [...session.branch] });
		},

		async ssh(session, input) {
			await session.commands.get("ssh").handler(input, contextOf(session));
		},
	};
}

/** The workspace an entry recorded, in the shape the session file holds it. */
export function recordedStates(session: LiveSession): Array<{ active: boolean; name: string; remoteCwd: string }> {
	return session.branch
		.filter((entry: any) => entry.type === "custom" && entry.customType === "pi-ssh-tools:target")
		.map((entry: any) => entry.data);
}
