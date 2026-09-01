import { describe, expect, it, vi } from "vitest";
import type { JourneyValidation, OndaClient } from "@onda/api-client";
import { createJourneyDraftSession, type JourneyDraftInput } from "./journey-persistence";

const appId = "app-1";
const journeyId = "journey-1";
const validation: JourneyValidation = { issues: [], estimated_count: 42, revision: "draft-revision-1" };

function input(title = "첫 번째 알림"): JourneyDraftInput {
  return {
    name: "가입 환영 저니",
    definition: {
      entry: { type: "blast", segment_id: "segment-1" },
      nodes: [{ type: "message", push: { title, body: "가입을 환영합니다." } }],
      exit: {},
      settings: { category: "marketing", reentry: "never" },
    },
  };
}

function client() {
  return {
    create: vi.fn<OndaClient["journeys"]["create"]>().mockResolvedValue({ id: journeyId, revision: validation.revision }),
    update: vi.fn<OndaClient["journeys"]["update"]>().mockResolvedValue({ ok: true, revision: validation.revision }),
    validate: vi.fn<OndaClient["journeys"]["validate"]>().mockResolvedValue(validation),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("journey draft persistence", () => {
  it("creates once across repeated saves and validates the same saved draft", async () => {
    const api = client();
    const session = createJourneyDraftSession(api, appId);
    const edited = input("수정한 알림");

    await expect(session.save(input())).resolves.toBe(journeyId);
    await expect(session.save(edited)).resolves.toBe(journeyId);
    await expect(session.validate(edited)).resolves.toEqual({ ...validation, id: journeyId });

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update).toHaveBeenLastCalledWith(appId, journeyId, edited);
    expect(api.validate).toHaveBeenCalledWith(appId, journeyId);
  });

  it("saves existing edits before validating instead of checking the stale server draft", async () => {
    const api = client();
    const update = deferred<{ ok: true; revision: string }>();
    api.update.mockReturnValueOnce(update.promise);
    const session = createJourneyDraftSession(api, appId, journeyId);
    const edited = input("활성화할 최신 내용");

    const result = session.validate(edited);
    await Promise.resolve();
    expect(api.update).toHaveBeenCalledWith(appId, journeyId, edited);
    expect(api.validate).not.toHaveBeenCalled();

    update.resolve({ ok: true, revision: validation.revision });
    await expect(result).resolves.toEqual({ ...validation, id: journeyId });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.validate).toHaveBeenCalledWith(appId, journeyId);
  });

  it("returns the newly created and validated ID for activation without creating a second draft", async () => {
    const api = client();
    const session = createJourneyDraftSession(api, appId);

    const result = await session.validate(input());
    expect(result.id).toBe(journeyId);
    expect(result.revision).toBe(validation.revision);
    expect(api.validate).toHaveBeenCalledWith(appId, result.id);

    await session.validate(input("검증 후 다시 수정한 내용"));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0]?.[1]).toBe(result.id);
  });

  it("allows a failed create to be retried without retaining a nonexistent ID", async () => {
    const api = client();
    api.create.mockRejectedValueOnce(new Error("create failed"));
    const session = createJourneyDraftSession(api, appId);

    await expect(session.save(input())).rejects.toThrow("create failed");
    await expect(session.validate(input())).resolves.toEqual({ ...validation, id: journeyId });

    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.update).not.toHaveBeenCalled();
    expect(api.validate).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping creation, validation, and saves without replacing a draft during validation", async () => {
    const api = client();
    const create = deferred<{ id: string; revision: string }>();
    const check = deferred<JourneyValidation>();
    const validationStarted = deferred<void>();
    api.create.mockReturnValueOnce(create.promise);
    api.validate.mockImplementationOnce(() => {
      validationStarted.resolve();
      return check.promise;
    });
    const session = createJourneyDraftSession(api, appId);
    const duringValidation = input("검증할 내용");
    const afterValidation = input("검증 후 저장할 내용");

    const first = session.save(input());
    const second = session.validate(duringValidation);
    const third = session.save(afterValidation);
    await Promise.resolve();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.update).not.toHaveBeenCalled();

    create.resolve({ id: journeyId, revision: validation.revision });
    await validationStarted.promise;
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledWith(appId, journeyId, duringValidation);

    check.resolve(validation);
    await expect(second).resolves.toEqual({ ...validation, id: journeyId });
    await expect(third).resolves.toBe(journeyId);
    await expect(first).resolves.toBe(journeyId);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update).toHaveBeenLastCalledWith(appId, journeyId, afterValidation);
  });

  it("does not validate after a failed update and can retry the same draft", async () => {
    const api = client();
    api.update.mockRejectedValueOnce(new Error("update failed"));
    const session = createJourneyDraftSession(api, appId, journeyId);

    await expect(session.validate(input())).rejects.toThrow("update failed");
    expect(api.validate).not.toHaveBeenCalled();

    await expect(session.validate(input())).resolves.toEqual({ ...validation, id: journeyId });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.validate).toHaveBeenCalledTimes(1);
  });

  it("blocks activation confirmation when another editor changes the draft between save and validate", async () => {
    const api = client();
    api.validate.mockResolvedValueOnce({ ...validation, revision: "another-editors-revision" });
    const session = createJourneyDraftSession(api, appId);
    await expect(session.validate(input())).rejects.toThrow("다른 편집 내용");
    await expect(session.validate(input())).resolves.toEqual({ ...validation, id: journeyId });
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledTimes(1);
  });
});
