import type { Event } from "./event";

export interface Wrapper {
  name(): string;
  model(): string;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  send(input: string): Promise<void>;
  interrupt(): Promise<void>;
  alive(): boolean;
  events(): AsyncIterable<Event>;
}
