import type { JourneyValidation, NudgeOnClient } from "@nudgeon/api-client";
import type { JourneyDefinition } from "@nudgeon/journey-model";

export interface JourneyDraftInput {
  name: string;
  definition: JourneyDefinition;
}

export interface JourneyDraftSession {
  save(input: JourneyDraftInput): Promise<string>;
  validate(input: JourneyDraftInput): Promise<{ id: string } & JourneyValidation>;
}

type JourneyDraftClient = Pick<NudgeOnClient["journeys"], "create" | "update" | "validate">;

/** Keep one draft ID and serialize saves with their associated validation. */
export function createJourneyDraftSession(
  client: JourneyDraftClient,
  appId: string,
  initialId?: string,
): JourneyDraftSession {
  let savedId = initialId;
  let pending: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    // A failed request must not prevent the next user-initiated retry.
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persist(input: JourneyDraftInput): Promise<{ id: string; revision: string }> {
    if (savedId) {
      const saved = await client.update(appId, savedId, input);
      return { id: savedId, revision: saved.revision };
    }

    const created = await client.create(appId, input);
    savedId = created.id;
    return created;
  }

  return {
    save(input) {
      const snapshot = structuredClone(input);
      return enqueue(async () => (await persist(snapshot)).id);
    },
    validate(input) {
      const snapshot = structuredClone(input);
      return enqueue(async () => {
        const saved = await persist(snapshot);
        const validation = await client.validate(appId, saved.id);
        if (!saved.revision || saved.revision !== validation.revision) {
          // 메시지 키(journeyEditor 네임스페이스) — 편집기가 t()로 번역해 보여준다.
          throw new Error("persistence.revisionMismatch");
        }
        return { ...validation, id: saved.id };
      });
    },
  };
}
