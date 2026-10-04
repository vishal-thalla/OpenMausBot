import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { approvalModeFor } from "../shared/approval-mode.ts";

it("allows confirmed paired admins to grant Full and preserves it across Claude/Codex switches", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, token?: string, expected = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}`, "x-forwarded-for": "192.0.2.10" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const pair = async (scopes: string[]) => {
    const offer = await api("POST", "/api/auth/pairing", { scopes });
    return (await api("POST", "/api/auth/pair", { code: offer.code })).token as string;
  };
  try {
    const admin = await pair(["admin", "client"]);
    const member = await pair(["client"]);
    const instances = (await api("GET", "/api/instances")).instances as any[];
    const selection = (id: string) => ({ instanceId: id, model: instances.find(instance => instance.instanceId === id).models.default });
    const bot = (await api("POST", "/api/bots", { name: "Remote admin fixture", modelSelection: selection("claude") }, undefined, 201)).bot;
    const route = `/api/bots/${bot.id}`;
    const thread = `${route}/tasks/${bot.threadId}`;
    expect(approvalModeFor(bot)).toBe("ask");
    const sibling = (await api("POST", `${route}/tasks`, { title: "Sibling" }, undefined, 201)).task;
    for (const path of [route, thread]) {
      await api("PATCH", path, { approvalMode: "full", confirmFullAccess: true }, undefined, 403);
      await api("PATCH", path, { approvalMode: "full", confirmFullAccess: true }, member, 403);
      await api("PATCH", path, { approvalMode: "full" }, admin, 403);
    }
    const granted = await api("PATCH", route, { approvalMode: "full", confirmFullAccess: true, applyToAllThreads: true }, admin);
    expect(granted.bot.approvalMode).toBe("full");
    expect(granted.bot.tasks.every((task: any) => task.approvalMode === "full")).toBe(true);
    for (const id of ["codex", "claude"]) {
      const switched = await api("PATCH", thread, { modelSelection: selection(id), updateBotDefault: true }, admin);
      expect(switched.bot).toMatchObject({ approvalMode: "full", modelSelection: selection(id) });
      expect(switched.task).toMatchObject({ approvalMode: "full", modelSelection: selection(id) });
    }
    // The broad settings route must carry the same consent as the thread route.
    expect((await api("PATCH", route, { modelSelection: selection("codex") })).bot.approvalMode).toBe("full");
    await api("PATCH", route, { approvalMode: "custom", confirmFullAccess: true }, admin, 403);
    await api("PATCH", thread, { approvalMode: "ask" }, admin);
    expect((await api("PATCH", thread, { approvalMode: "full", confirmFullAccess: true }, admin)).task.approvalMode).toBe("full");
    await api("PATCH", thread, { approvalMode: "ask" }, admin);
    expect((await api("PATCH", thread, { refreshPermissions: true, confirmFullAccess: true }, admin)).task.approvalMode).toBe("full");
    // Ask survives a provider switch too; siblings retain their explicit level.
    await api("PATCH", thread, { approvalMode: "ask" }, admin);
    const ask = await api("PATCH", thread, { modelSelection: selection("claude") }, admin);
    expect(ask.task.approvalMode).toBe("ask");
    expect(ask.bot.tasks.find((task: any) => task.threadId === sibling.threadId).approvalMode).toBe("full");
    const fresh = (await api("POST", "/api/bots", { name: "Still Ask" }, admin, 201)).bot;
    expect(approvalModeFor(fresh)).toBe("ask");
    const revoked = await pair(["admin", "client"]);
    const identity = await api("GET", "/api/auth/session", undefined, revoked);
    await api("DELETE", `/api/auth/sessions/${identity.id}`, undefined, admin);
    await api("PATCH", route, { approvalMode: "full", confirmFullAccess: true }, revoked, 401);
  } finally {
    await fixture.close();
  }
}, 60_000);
