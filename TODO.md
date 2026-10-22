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

## No persistent remote shell

A command running under `ssh_bash` dies with the connection. Keeping it would mean
starting it under a remote session wrapper (`tmux`, `screen`, or `nohup` plus a log
file) and re-attaching later, which is a different product: a session name, a way to
poll output, and a kill command.

Not doing this. The model should not see a persistent remote shell. `ssh_bash` stays a
one-shot command, and a dropped link ends it.

## Stop the remote command when a call is cancelled

Cancelling an `ssh_bash` - Esc, or a timeout - ends the local call promptly: the client
runs in its own process group, so the signal reaches whatever it forked as well, and the
call settles when the client exits instead of when its pipes close.

`ControlMaster` makes it worse rather than better: the mux master owns the channel, so
killing the client does not even close it, and the master keeps the output flowing.

What still keeps running is the remote side. Without a PTY the sshd does not send SIGHUP
when the channel dies, so an aborted `npm run build` carries on on the host and may hold a
lock the next call then waits on. Allocating a PTY (`-t`) would fix that, at the cost of
escape sequences and `\r\n` in the captured output. A wrapper script that traps and kills
its own process group was the other option, but that wrapper only makes sense as part of a
persistent remote shell, which this package will not grow.
