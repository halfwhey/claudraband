import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { streamInputLines } from "./input-lines";

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

describe("streamInputLines", () => {
  test("yields lines before the input stream closes", async () => {
    const input = new PassThrough();
    const iterator = streamInputLines(input)[Symbol.asyncIterator]();

    input.write("first\n");
    const first = await Promise.race([iterator.next(), timeout(200)]);
    expect(first).toEqual({ value: "first", done: false });

    input.end("second\n");
    expect(await iterator.next()).toEqual({ value: "second", done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});
