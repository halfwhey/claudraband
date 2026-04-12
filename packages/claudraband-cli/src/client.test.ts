import { describe, expect, test } from "bun:test";
import { requestPermission } from "./client";

describe("requestPermission", () => {
  test("does not print duplicate title content or duplicate kind suffixes", async () => {
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await requestPermission(
        { ensureNewline() {} } as never,
        { interactive: false, answerChoice: "1", promptText: "" },
        {
          source: "native_prompt",
          sessionId: "sid",
          toolCallId: "tool",
          title: "Do you want to proceed?",
          kind: "execute",
          content: [{ type: "text", text: "Do you want to proceed?" }],
          options: [
            { kind: "allow_once", optionId: "1", name: "Yes (allow_once)" },
            { kind: "reject_once", optionId: "2", name: "No" },
          ],
        },
      );

      expect(result).toEqual({ outcome: "selected", optionId: "1" });
      const output = writes.join("");
      expect(output.match(/Do you want to proceed\?/g)?.length).toBe(1);
      expect(output).toContain("1. Yes (allow_once)\n");
      expect(output).not.toContain("Yes (allow_once) (allow_once)");
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
