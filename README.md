# pi-ssh-tools

Explicit SSH tools for [pi](https://github.com/earendil-works/pi).

> Standalone, independently maintained fork of `pi-ssh-tools`, originally written by [Can Celik](https://github.com/ogulcancelik) inside the [`pi-extensions`](https://github.com/ogulcancelik/pi-extensions) monorepo. MIT licensed with the original copyright intact — see [License](#license).

Turn SSH mode on only when you need it, keep local tools untouched, and give the agent a separate remote toolset:

- `ssh_read`
- `ssh_write`
- `ssh_edit`
- `ssh_bash`

## Install

```bash
pi install git:github.com/Echokovo/pi-ssh-tools
```

Or add manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/Echokovo/pi-ssh-tools"]
}
```

## What it does

This package adds a `/ssh` command.

- Default is off
- No persistence across sessions
- Local `read`, `write`, `edit`, and `bash` stay local
- When SSH mode is active, the agent also gets `ssh_read`, `ssh_write`, `ssh_edit`, and `ssh_bash`
- The active remote host and cwd are injected into the system prompt while SSH mode is on
- While SSH mode is active, the `!` and `!!` commands you type yourself also run on the remote host
- Prefix one of those commands with `local:` to keep it on your own machine

That makes remote work explicit instead of silently swapping out local tools.

## Usage

```text
/ssh
/ssh mac
/ssh clawd
/ssh mac:/Users/can/project
/ssh status
/ssh off
```

When `/ssh` is called with no arguments, the extension offers hosts from `~/.ssh/config`.

You can always bypass the picker and type a host manually:

```text
/ssh user@host
/ssh user@host:/remote/path
```

That means the package still works even if you do not use `~/.ssh/config`.

## How host selection works

The picker reads `Host ...` aliases from your local `~/.ssh/config`.

- wildcard entries like `Host *` are ignored
- aliases are used as the SSH target directly
- if no remote path is provided, the extension resolves it with `ssh <host> pwd`

This is mainly a convenience layer. SSH config is not required for the actual remote tools.

## How `!` and `!!` behave

pi normally runs commands you type with `!` and `!!` in a local shell. While SSH mode is on, this package handles pi's `user_bash` event and runs them on the active host in the active remote working directory, so `!git status` inspects the remote checkout.

`!!` keeps its usual meaning: the command still runs, and its output stays out of the model context.

To run one command locally while SSH mode is on, prefix it with `local:`:

```text
!local: pwd
!!local: uname -a
```

The marker is stripped before execution. It only applies while SSH mode is on: with SSH mode off this package does not intercept `!` and `!!` at all, so `local:` reaches your shell as a command name. You get a warning before that happens.

Two details worth knowing:

- `shellCommandPrefix` from settings is dropped for remote commands, because it usually sources local shell setup such as `~/.bash_aliases`. It still applies to `local:` commands.
- Remote commands run in a non-interactive shell, exactly like `ssh_bash`. Full-screen programs such as `vim` or `htop` are not supported.

## Integration with pi-permission-system

[`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system) gates tool calls by path. For extension tools it extracts `input.path` by convention and resolves it against the **local** filesystem, which is wrong for `ssh_read`, `ssh_write`, and `ssh_edit`: those paths are remote. A remote `/etc/nginx/nginx.conf` raises an `external_directory` ask, and a remote `.env` matches a local `*.env` deny rule.

When that package is loaded, this package registers an extractor for those three tools that declines to report a path. Both path gates then skip them, and the per-tool rule (`permission` in its config) decides on the tool name alone. `ssh_bash` needs nothing: its input carries `command`, not `path`.

The integration is optional, discovered at runtime through that package's process-global service slot (`Symbol.for("@gotgenes/pi-permission-system:session-services")`), so there is no dependency to install and nothing to configure. `/ssh status` reports which way it landed:

- `remote paths are exempt from the local path gates`
- `permission-system service not found - remote paths are still judged as local paths`

Understand what that buys: remote files are then governed by the SSH target you picked, not by rules written for local paths. That is the only honest boundary here, since `ssh_bash` can already reach any path on the active host.

## Requirements

- [pi](https://github.com/earendil-works/pi)
- local `ssh` client available in `$PATH`
- key-based auth or another non-interactive SSH setup
- `bash` available on the remote host

## Notes

- `ssh_write` writes file content over stdin, which behaves better on macOS than GNU-specific `base64 -d` shell snippets
- relative remote paths resolve against the active remote cwd
- image reads are supported for common extensions: jpg, jpeg, png, gif, webp

## License

MIT — see [LICENSE](LICENSE), `Copyright (c) 2025 Can Celik`.

### Provenance

- Upstream: [`ogulcancelik/pi-extensions`](https://github.com/ogulcancelik/pi-extensions), package `packages/pi-ssh-tools`, published to npm as `@ogulcancelik/pi-ssh-tools` up to `0.1.6`.
- This repository was created with `git subtree split --prefix=packages/pi-ssh-tools`, so the upstream commit history and authorship are preserved.
- `0.2.0` is the standalone release, and it adds the `user_bash` routing described above: `!` and `!!` follow the active SSH host, `local:` keeps a single command local.
- Maintained independently from here on. Not an upstream release, and not endorsed by the original author.
