# TODO

Deferred work, with the reasons it was deferred. Nothing below is measured on this
machine; the claims about cost and behaviour come from reading `ssh` documentation and
[`petrichor20211/pi-ssh-remote`](https://github.com/petrichor20211/pi-ssh-remote), which
solves the same problems with a persistent `ssh2` connection instead of a per-call
`/usr/bin/ssh`.

## Reuse one connection (ControlMaster)

Every tool call is a separate `ssh` process, so each one pays a full TCP + key-exchange
handshake. `ControlMaster=auto` with a `ControlPath` and `ControlPersist=120` would let
the ssh client reuse one connection and silently re-dial a dropped one, which is most of
what a persistent connection buys.

Not done yet because:

- `ControlPath` must fit `sun_path` (~108 bytes on Linux), so the socket name needs a
  short hash under `$XDG_RUNTIME_DIR` or `/tmp` rather than a long per-host path.
- Windows OpenSSH does not support ControlMaster, so it needs a capability probe and a
  fallback, and the fallback path then has to be tested too.
- Sockets have to be cleaned up (`ssh -O exit`), or a stale socket makes later calls fail
  in ways users will read as a bug in this extension.
- The benefit is unmeasured here. Measure the handshake cost on a real host before
  building this.

## Retry idempotent reads once

`ssh_read` is safe to repeat, so a single transport failure (exit 255 classified as
`dropped` or `could not be connected to`) could be retried once before surfacing an error.
`ssh_write` and `ssh_edit` must not be retried blindly: a write that died mid-transfer may
already have landed.

Not done yet because the failure classification is brand new and only covered by faked
`ssh` output. Let it see real hosts first, otherwise a retry policy would be built on
patterns nobody has observed.

## Keep a remote command alive when the link drops

A command running under `ssh_bash` dies with the connection. Nothing in the ssh client can
prevent that; the command has to be started under a remote session wrapper (`tmux`,
`screen`, or `nohup` plus a log file) and re-attached later.

This is a different product shape from the current one-shot `ssh_bash`: it needs a session
name, a way to poll output, and a kill command. Worth a separate release, and worth asking
whether the model should see a persistent remote shell at all.

## Make the timeouts configurable

`ConnectTimeout=10`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`, and the 5s probe
timeout are constants in `index.ts`. High-latency links (VPN, jump hosts through the
GFW) may need a longer connect timeout, which currently means editing the source.

Deferred deliberately: a settings surface needs a documented default and a place to show
the effective value, and there is no evidence yet that anyone needs to change them.
