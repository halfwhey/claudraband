.PHONY: build build-lib build-cli test typecheck clean publish

build: build-lib build-cli

build-lib:
	cd packages/claudraband-core && bun run build

build-cli:
	cd packages/claudraband-cli && bun run build

test:
	bun test packages/claudraband-core/src packages/claudraband-cli/src

typecheck:
	packages/claudraband-cli/node_modules/.bin/tsc -p packages/claudraband-core/tsconfig.json --noEmit
	packages/claudraband-cli/node_modules/.bin/tsc -p packages/claudraband-cli/tsconfig.json --noEmit

clean:
	rm -rf packages/claudraband-core/dist
	rm -rf packages/claudraband-cli/dist

publish: build
	cd packages/claudraband-cli && npm publish --access restricted
