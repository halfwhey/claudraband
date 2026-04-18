# Docker

Use this image in two steps:

1. Run a one-time onboarding session with `claude`.
2. Start the API in `serve` mode using the same mounted account bundle.

The container persists Claude state in one host directory mounted at `/claude-account`.

## Account bundle mount

The image links container home paths to the mount when present:

```text
/root/.claude      -> /claude-account/.claude
/root/.claude.json -> /claude-account/.claude.json
```

Create one directory per account:

```sh
mkdir -p ./accounts/personal ./accounts/work
```

Mount one directory per container run with `-v <host-dir>:/claude-account`.

## Step 1: run onboarding (`claude`)

Start an interactive container and complete first-run setup:

```sh
docker run --rm -it \
  -v "$PWD/accounts/personal:/claude-account" \
  claudraband claude
```

If the mount is empty, onboarding writes `.claude` and `.claude.json` into that directory.

## Step 2: run the daemon (`serve`)

Start the service from the same mounted bundle. `serve` expects onboarding state to exist in that mount, so finish step 1 first:

```sh
docker run --rm -d --name claudraband \
  -p 7842:7842 \
  -v "$PWD/accounts/personal:/claude-account" \
  claudraband serve
```

`serve` is the default entrypoint, so `claudraband` alone is equivalent.

```sh
docker run --rm -d --name claudraband \
  -p 7842:7842 \
  -v "$PWD/accounts/personal:/claude-account" \
  claudraband
```

Use your host tooling to inspect runtime logs:

```sh
docker logs -f claudraband
```

## Multiple accounts with bind mounts

Keep each account in its own host directory and only swap the bind mount path.

```sh
docker run --rm -d --name claudraband-personal \
  -p 7842:7842 \
  -v "$PWD/accounts/personal:/claude-account" \
  claudraband

docker run --rm -d --name claudraband-work \
  -p 7843:7842 \
  -v "$PWD/accounts/work:/claude-account" \
  claudraband
```

This keeps sessions, theme, and login state isolated per account without any copy step.

## Direct mount alternative

You can skip `/claude-account` and mount state files directly:

```sh
docker run --rm -d --name claudraband \
  -p 7842:7842 \
  -v "$HOME/.claude:/root/.claude" \
  -v "$HOME/.claude.json:/root/.claude.json" \
  claudraband
```

This uses your host files at `/root/.claude*` paths and is a valid alternative when you need a one-to-one mount setup instead of account directories.
