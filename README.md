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
- SSH mode follows the session: `/resume`, `/fork`, `/clone`, `/new`, and `/tree` bring the workspace back or drop it with the session
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
/ssh mac:/home/can/project
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
- Remote commands run in a non-interactive shell, exactly like `ssh_bash`. Full-screen programs such as `vim` or `htop` are not supported, and neither is a persistent remote shell: `ssh_bash` is a one-shot command, so a dropped link ends it.

## SSH mode follows the session

Connecting records the host and the remote cwd into the session, so the workspace travels with it:

- `/resume`, `/fork`, and `/clone` come back with the same host and remote cwd
- `/new` and `/reload` inherit the workspace from the session you were just in
- `/tree` follows the point you move to — a point before the connect has no SSH mode
- `/ssh off` is recorded too, so a later session does not resurrect a workspace you closed on purpose
- a fresh session with no history starts off and writes nothing

`/ssh status` names where the current workspace came from: this session, the session file, or the previous session.

A restored workspace is announced above the editor rather than in the transcript, where the
conversation would push it out of sight:

```
SSH mac  /home/lin/ws/api
restored from this session file · ! and !! run remotely · prefix local: for local
```

Those two lines stay until your first message or `!` command. The footer keeps naming the
host for as long as SSH mode is on, and `/ssh status` gives the full picture.

Restoring runs a background reachability probe. If the host does not answer, you get a warning pointing at `/ssh status`; SSH mode stays on, because the host may simply be down for a moment and reconnecting is one `/ssh <host>` away.

What does not travel: there is no live connection to hand over, and a command that was mid-flight when the session ended is not resumed. Recovery is a fresh SSH connection, which is all this package ever used.

## Integration with pi-permission-system

[`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system) gates tool calls by path. For extension tools it extracts `input.path` by convention and resolves it against the **local** filesystem, which is wrong for `ssh_read`, `ssh_write`, and `ssh_edit`: those paths are remote. A remote `/etc/nginx/nginx.conf` raises an `external_directory` ask, and a remote `.env` matches a local `*.env` deny rule.

When that package is loaded, this package registers an extractor for those three tools that declines to report a path. Both path gates then skip them, and the per-tool rule (`permission` in its config) decides on the tool name alone. `ssh_bash` needs nothing: its input carries `command`, not `path`.

The integration is optional, discovered at runtime through that package's process-global service slot (`Symbol.for("@gotgenes/pi-permission-system:session-services")`), so there is no dependency to install and nothing to configure. `/ssh status` reports which way it landed:

- `remote paths are exempt from the local path gates`
- `permission-system service not found - remote paths are still judged as local paths`

Understand what that buys: remote files are then governed by the SSH target you picked, not by rules written for local paths. That is the only honest boundary here, since `ssh_bash` can already reach any path on the active host.

## Reusing the SSH connection

Every tool call is its own `ssh` process, and this package sets no `ControlMaster` option, so by default each call pays a full TCP + key-exchange handshake. OpenSSH can share one connection between those processes. It is configured in `~/.ssh/config`, and the package needs no change to benefit from it. Add this for the hosts you use with `/ssh`:

```
Host mac
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 120
```

Or for every host:

```
Host *
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 120
```

- Keep `ControlPersist`. Without it, the first `ssh` process stays alive as the master and holds the stdout/stderr pipes this package waits on, so a call may never return. With it, the master moves to the background and each call exits normally.
- `%C` is a hash of the connection, so the socket path stays short enough for the ~108-byte Unix socket limit.
- No cleanup is needed. The master exits after 120 idle seconds, and ssh dials a new connection when it finds a stale socket.
- `ConnectTimeout` only applies while the master is being established, and `ServerAliveInterval` / `ServerAliveCountMax` follow the call that created it.
- Check that it took effect with `ssh -G <host> | rg -i '^control'`: `controlmaster` should be `auto` and `controlpersist` should not be `no`. `PI_SSH_TOOLS_DEBUG=1` then shows the first call slower than the ones after it.

## Debugging

```bash
PI_SSH_TOOLS_DEBUG=1 pi
```

Every `ssh` call then appends one line to `pi-ssh-tools.log` in your temp directory
(`/tmp/pi-ssh-tools.log`):

```
2026-10-18T14:31:52.002Z mac exit=1 1ms cmd="if [ ! -e '/home/lin/notes.md' ]; ..." stderr="no such file: /home/lin/notes.md"
```

That is the whole call — host, exit code, duration, the command that ran, and what ssh
said — including the background probes and calls that never reached a tool. File content
is never written to it. Unset the variable and nothing is logged.

## Requirements

- [pi](https://github.com/earendil-works/pi)
- Linux as the local machine. macOS and Windows are not targeted
- local `ssh` client available in `$PATH`
- key-based auth: every call runs with `BatchMode=yes`, so ssh is never allowed to ask for a passphrase, a password, or a host-key answer
- `bash` available on the remote host

Those prompts are read from the terminal, which is pi's keyboard rather than this
extension's pipe, so an interactive host now fails immediately instead of hanging or
stealing input. Put the key in `ssh-agent` or set `IdentityFile` in `~/.ssh/config`, and
accept a new host key once from your own terminal before pointing `/ssh` at it.

## Notes

- `ssh_write` writes file content over stdin, instead of going through `base64 -d` shell snippets
- relative remote paths resolve against the active remote cwd
- `~` means the **remote** user's home: `~/notes.md` is expanded against the host's `$HOME`, asked once per connection and only when a path needs it, the way a `!` command on that host already reads it; `~user` is refused
- image reads are supported for common extensions: jpg, jpeg, png, gif, webp
- `ssh_read`, `ssh_write`, `ssh_edit`, and `ssh_bash` are pi's own `read` / `write` / `edit` / `bash` tools with remote operations behind them, so they keep pi's parameter schema, structured output, constrained sampling, truncation limits, and tool-row display: the `(timeout 30s)` suffix, the `Elapsed` / `Took` timing, and the edit tool's own frame. Only the leading sentence of each description is rewritten for the remote host
- every `ssh` call also sets `ConnectTimeout=10`, `ServerAliveInterval=15`, and `ServerAliveCountMax=3`: an unreachable host fails in seconds instead of waiting on the OS TCP timeout, and a link that dies mid-session is noticed after ~45s
- exit code 255 is ssh's own failure code, so it is reported as a transport failure (`SSH to mac did not resolve - the command did not run`) rather than as a command that failed; an unrecognised 255 is left alone, because a remote command is allowed to exit 255 too

## License

MIT — see [LICENSE](LICENSE), `Copyright (c) 2025 Can Celik`.

### Provenance

- Upstream: [`ogulcancelik/pi-extensions`](https://github.com/ogulcancelik/pi-extensions), package `packages/pi-ssh-tools`, published to npm as `@ogulcancelik/pi-ssh-tools` up to `0.1.6`.
- This repository was created with `git subtree split --prefix=packages/pi-ssh-tools`, so the upstream commit history and authorship are preserved.
- `0.2.0` is the standalone release, and it adds the `user_bash` routing described above: `!` and `!!` follow the active SSH host, `local:` keeps a single command local.
- `0.2.1` adds the optional `@gotgenes/pi-permission-system` integration described above, so remote paths stop being judged as local ones.
- `0.2.2` records the SSH workspace in the session, so `/resume`, `/fork`, `/clone`, `/new`, `/reload`, and `/tree` carry it the way the session carries everything else. It also puts `BatchMode`, `ConnectTimeout`, and keepalive options on every `ssh` call, reports exit 255 as a transport failure instead of a failed command, and stops a broken stdin pipe from taking the process down when ssh exits before reading it. A path starting with `~` now means the remote home instead of being silently rewritten to your local one, a remote file that cannot be read names the reason it cannot, and `PI_SSH_TOOLS_DEBUG=1` logs every call. A restored workspace is announced in a two-line notice above the editor instead of a transcript line that scrolls away.
- Maintained independently from here on. Not an upstream release, and not endorsed by the original author.
