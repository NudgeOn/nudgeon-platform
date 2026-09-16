import { describe, expect, it } from "vitest";
import type { MessageLogEntry } from "@nudgeon/api-client";
import { guidanceKey, isRecordId, logStatus, matchesLogSearch, statusGroup } from "./log-model";
const row: MessageLogEntry = { message_id:"aaa",user_id:"bbb",device_id:"ccc",campaign_ref:"test:run-1",channel:"push",status:"failed",failure_class:"invalid_token",failure_detail:"Token expired",idempotency_key:"d",journey_id:"",journey_version:0,node_index:0,sent_at:"" };
describe("message log presentation", () => {
 it("does not offer links for sentinel IDs or untrusted URL text", () => {
  expect(isRecordId("00000000-0000-0000-0000-000000000000")).toBe(false);
  expect(isRecordId("javascript:alert(1)")).toBe(false);
  expect(isRecordId("d467b18c-a550-46e6-a311-7aa8ebfa12b0")).toBe(true);
 });
 it("searches exact run/customer/message details case-insensitively", () => {
  expect(matchesLogSearch(row,"  EXPIRED  ")).toBe(true);
  expect(matchesLogSearch(row,"run-1")).toBe(true);
  expect(matchesLogSearch(row,"bbb")).toBe(true);
  expect(matchesLogSearch(row,"other")).toBe(false);
 });
 it("groups all skip reasons without describing provider acceptance as delivery", () => {
  expect(statusGroup("skipped_stale")).toBe("skipped");
  expect(statusGroup("new_status")).toBe("unknown");
  expect(guidanceKey({...row,status:"sent"})).toBe("sent");
  expect(guidanceKey({...row,status:"skipped_cap"})).toBe("skipped_cap");
  expect(logStatus("untrusted")).toBe("all");
 });
});
