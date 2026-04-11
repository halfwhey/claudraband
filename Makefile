.PHONY: build build-lib build-acp build-cli build-launchers test typecheck clean

build: build-lib build-acp build-cli build-launchers

build-lib:
	cd packages/claudraband-core && bun run build

build-acp:
	cd packages/claudraband-acp && bun run build

build-cli:
	cd packages/claudraband-cli && bun run build

build-launchers:
	chmod +x claudraband claudraband-acp

test:
	bun test packages/claudraband-core/src packages/claudraband-acp/src packages/claudraband-cli/src

typecheck:
	packages/claudraband-acp/node_modules/.bin/tsc -p packages/claudraband-core/tsconfig.json --noEmit
	packages/claudraband-acp/node_modules/.bin/tsc -p packages/claudraband-acp/tsconfig.json --noEmit
	packages/claudraband-acp/node_modules/.bin/tsc -p packages/claudraband-cli/tsconfig.json --noEmit

clean:
	rm -rf packages/claudraband-core/dist
	rm -rf packages/claudraband-acp/dist
	rm -rf packages/claudraband-cli/dist
