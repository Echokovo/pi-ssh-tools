import { resolvePackage } from "./resolve.mjs";

/**
 * Node's resolver is asked for every specifier before anything is loaded, so this answers the two
 * package names the extension imports. pi's own extension loader does the same thing with jiti
 * aliases when it loads this file inside a running pi; doing it here keeps the tests on the same
 * modules pi would hand the extension.
 */
export async function resolve(specifier, context, next) {
	const target = resolvePackage(specifier);
	if (target) {
		return { url: target, shortCircuit: true, format: "module" };
	}
	return next(specifier, context);
}
