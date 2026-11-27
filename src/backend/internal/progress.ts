import type { SavedProgress, SaveProgress } from "../../types.ts";
import type { AuthenticatedRequest } from "./auth.ts";
import { waitFor } from "./wait-for.ts";

export class Progress {
  private readonly saves = new Map<
    string,
    {
      input: string;
      result: Promise<SavedProgress>;
    }
  >();

  constructor(private readonly request: AuthenticatedRequest) {}

  clear(): void {
    this.saves.clear();
  }

  readProgress(signal?: AbortSignal): Promise<SavedProgress> {
    return this.request("GET", "/game/progress", undefined, signal);
  }

  saveProgress(
    input: SaveProgress,
    signal?: AbortSignal,
  ): Promise<SavedProgress> {
    const requestId = input.request_id;
    const serialized = JSON.stringify(input);
    const existing = this.saves.get(requestId);
    if (existing) {
      if (existing.input !== serialized) {
        return Promise.reject(new Error("request_id_reused"));
      }
      // 첫 호출자가 요청을 소유한다. 이후 호출자는 각자의 대기만 취소할 수 있다.
      return waitFor(existing.result, signal);
    }
    const result = this.request<SavedProgress>(
      "PUT",
      "/game/progress",
      serialized,
      signal,
    );
    const entry = { input: serialized, result };
    this.saves.set(requestId, entry);
    const cleanup = () => {
      if (this.saves.get(requestId) === entry) this.saves.delete(requestId);
    };
    void result.then(cleanup, cleanup);
    return result;
  }
}
