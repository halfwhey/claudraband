# Docker

The Docker image exposes two modes for each mounted Claude account:

1. `claude`: open plain Claude Code directly in the terminal.
2. `serve`: start the `claudraband` daemon directly using that same mounted account.

This keeps Claude account state outside the container so you can switch accounts by swapping one mounted directory.

## Account Layout

Create one host directory per Claude account:

```text
claude-account-1/
claude-account-2/
```

After the first successful `claude` run, each mounted directory contains:

```text
claude-account-1/
  .claude/
  .claude.json
```

Initialize the top-level directories once:

```sh
mkdir -p claude-account-1 claude-account-2
```

Mount one account directory into the container:

- `claude-account-N` -> `/claude-account`

On first `claude` run, the entrypoint creates `.claude/` and `.claude.json`
inside the mounted directory automatically.

## Build

```sh
docker build -t claudraband .
```

## Plain Claude Mode

Run the image in `claude` mode with one account mounted:

```sh
docker run --rm -it \
  -v "$PWD/claude-account-1:/claude-account" \
  claudraband claude
```

This opens plain Claude Code directly. Use it for first-run login, theme selection, and any later direct Claude sessions you want to run against that mounted account. If the mounted directory is empty, the container initializes the Claude state bundle before launching.

## Claudraband Daemon Mode

Reuse the same account mount in `serve` mode:

```sh
docker run --rm -d --name claudraband \
  -p 7842:7842 \
  -v "$PWD/claude-account-1:/claude-account" \
  claudraband serve
```

`serve` is also the default mode, so this is equivalent:

```sh
docker run --rm -d --name claudraband \
  -p 7842:7842 \
  -v "$PWD/claude-account-1:/claude-account" \
  claudraband
```

The daemon runs directly as PID 1, so container logs, signals, and exit codes come from `cband serve` itself. Inside the daemon, Claude sessions still default to the tmux backend unless you override `--backend`.

`serve` adds `--host 0.0.0.0 --port 7842` by default so the published port is reachable from the host. If you pass your own `--host` or `--port`, those override the defaults:

```sh
docker run --rm -d --name claudraband-alt \
  -p 9000:9000 \
  -v "$PWD/claude-account-1:/claude-account" \
  claudraband serve --port 9000
```

Stream logs with:

```sh
docker logs -f claudraband
```

## Switch Accounts

To use another Claude account, change only the mounted host directory:

```sh
docker run --rm -d --name claudraband \
  -p 7842:7842 \
  -v "$PWD/claude-account-2:/claude-account" \
  claudraband serve
```

Each mounted folder keeps its own Claude login and onboarding state.

## Compatibility

The entrypoint still accepts:

- the older two-mount layout to `/root/.claude` and `/root/.claude.json`
- the older `onboard` subcommand as an alias for `claude`

The single `/claude-account` mount plus `claude`/`serve` subcommands are the preferred interface.
