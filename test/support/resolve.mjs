import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI_NAME = "@earendil-works/pi-coding-agent";
const TUI_NAME = "@earendil-works/pi-tui";

function packageJson(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
}

function isPackage(dir, name) {
	return packageJson(dir)?.name === name;
}

function fromEnvironment() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) {
		return undefined;
	}
	const dir = resolvePath(configured);
	if (!isPackage(dir, PI_NAME)) {
		throw new Error(`PI_CODING_AGENT_DIR=${configured} is not a ${PI_NAME} package directory`);
	}
	return dir;
}

function fromNodeResolution() {
	let url;
	try {
		url = import.meta.resolve(PI_NAME);
	} catch {
		return undefined;
	}
	if (!url.startsWith("file:")) {
		return undefined;
	}
	let dir = dirname(fileURLToPath(url));
	while (dir !== dirname(dir)) {
		if (isPackage(dir, PI_NAME)) {
			return dir;
		}
		dir = dirname(dir);
	}
	return undefined;
}

/** Where a globally installed pi is likely to have been unpacked. */
function globalInstalls() {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const prefixes = [
		// npm sets this for the scripts it runs, so "npm test" finds the prefix it was run from.
		process.env.npm_config_prefix,
		process.env.PREFIX,
		process.env.HOMEBREW_PREFIX,
		"/usr/local",
		"/usr",
		"/opt/homebrew",
		"/home/linuxbrew",
		home && join(home, ".linuxbrew"),
		home && join(home, ".npm-global"),
	].filter((prefix) => Boolean(prefix));
	const candidates = prefixes.map((prefix) => join(prefix, "lib", "node_modules", PI_NAME));
	if (home) {
		candidates.push(join(home, ".bun", "install", "global", "node_modules", PI_NAME));
	}
	return candidates;
}

function fromGlobalInstalls() {
	for (const candidate of globalInstalls()) {
		if (isPackage(candidate, PI_NAME)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * The pi install the tests run against.
 *
 * The extension imports pi and pi-tui by package name, and so does pi itself. Neither name
 * resolves from this repository unless the dev dependency is installed, and the pi that loads
 * this extension in real use is usually installed somewhere else entirely, so the tests resolve
 * both names to one install themselves. One install means one copy of every class, which is what
 * keeps the `instanceof` checks in pi's own rendering code working on components built here.
 */
export function piPackageDir() {
	const dir = fromEnvironment() ?? fromNodeResolution() ?? fromGlobalInstalls();
	if (dir) {
		return dir;
	}
	throw new Error(
		`Could not find an install of ${PI_NAME}. Run "npm install" in this directory, or point ` +
			"PI_CODING_AGENT_DIR at an unpacked pi-coding-agent package, for example " +
			'PI_CODING_AGENT_DIR=/usr/local/lib/node_modules/@earendil-works/pi-coding-agent npm test.',
	);
}

/** Absolute path to a file inside the pi package. */
export function piFile(...parts) {
	return join(piPackageDir(), ...parts);
}

/** Import a pi module by its path inside the package, e.g. `dist/utils/mime.js`. */
export function piImport(pathInsidePackage) {
	return import(pathToFileURL(piFile(pathInsidePackage)).href);
}

function piTuiEntry() {
	const pi = piPackageDir();
	const candidates = [
		join(pi, "node_modules", TUI_NAME, "dist", "index.js"),
		join(pi, "..", TUI_NAME, "dist", "index.js"),
		join(pi, "..", "..", TUI_NAME, "dist", "index.js"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	throw new Error(`Could not find ${TUI_NAME} next to ${pi}. It ships as a dependency of pi, so an unpacked pi should contain it.`);
}

/** Map the two package names the extension imports onto one pi install. */
export function resolvePackage(specifier) {
	if (specifier === PI_NAME) {
		return pathToFileURL(join(piPackageDir(), "dist", "index.js")).href;
	}
	if (specifier === TUI_NAME) {
		return pathToFileURL(piTuiEntry()).href;
	}
	return undefined;
}
