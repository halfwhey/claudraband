.PHONY: build test typecheck clean run

BIN := allagent

build:
	bun build src/main.ts --compile --outfile $(BIN)

test:
	bun test

typecheck:
	tsc --noEmit

clean:
	rm -f $(BIN)

run: build
	./$(BIN)
