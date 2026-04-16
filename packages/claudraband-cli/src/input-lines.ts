import readline from "node:readline";

export async function* streamInputLines(
  input: NodeJS.ReadableStream,
): AsyncGenerator<string> {
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });

  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
  }
}
