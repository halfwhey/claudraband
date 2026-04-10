.PHONY: build test vet clean

BIN := allagent

build:
	go build -o $(BIN) .

test:
	go test ./... -count=1 -timeout=30s

vet:
	go vet ./...

clean:
	rm -f $(BIN)
	go clean -testcache

run: build
	./$(BIN) --model sonnet
