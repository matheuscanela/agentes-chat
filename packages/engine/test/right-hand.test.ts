import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  archiveAgent,
  BUILTIN_SCOPES,
  buildRunContext,
  changeMemberRole,
  createAgent,
  createChannel,
  createOrganization,
  deleteAgent,
  drainOutbox,
  ensureRightHand,
  ensureRightHands,
  exportBundle,
  grantedScopeKeys,
  grantKey,
  insertMessage,
  isAllowed,
  NOT_IN_ALL,
  openPersonAgentDm,
  postPersonMessage,
  RIGHT_HAND,
  RIGHT_HAND_GRANTS,
  reflectThread,
  rightHandPrompt,
  setAgentAudience,
  setAgentChannels,
  setAgentComputerTarget,
  setBillingHold,
  toolAccess,
  updateAgent,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const rightHandOf = async (orgId: string) =>
  f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, RIGHT_HAND)));

test("every workspace comes with one right hand, Lodi, owned by its owner", async () => {
  f = await setup({ rightHand: true });
  const [lodi, ...more] = await rightHandOf(f.org.id);
  expect(more).toEqual([]);
  expect(lodi).toMatchObject({
    name: "Lodi",
    handle: "lodi",
    model: "auto",
    ownerUserId: f.owner.id,
    monthlyBudgetNanoUsd: null,
    audienceMode: "everyone",
    machineId: null,
    appearance: { color: "teal", eyes: "happy", accessory: "headset" },
  });
  // Again changes nothing.
  expect(await ensureRightHand(f.db, f.org.id)).toBeNull();
  expect(await rightHandOf(f.org.id)).toHaveLength(1);
});

test("the boot backfill gives older workspaces theirs, not one being deleted, and takes the next free handle", async () => {
  f = await setup();
  // `setup` leaves the workspace without it, as one made before it; `@lodi` is taken there.
  await createAgent(f.db, f.owner.id, f.org.id, { name: "Lodi", handle: "lodi" }, { model: "claude-sonnet-5-5" });
  const other = await addUser(f.db, "bia");
  const { organization: closing } = await createOrganization(f.db, other.id, { name: "Closing" });
  await f.db.delete(schema.agents).where(eq(schema.agents.orgId, closing.id));
  await f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() + 86_400_000) })
    .where(eq(schema.organizations.id, closing.id));
  expect(await ensureRightHands(f.db)).toBe(1);
  expect((await rightHandOf(f.org.id))[0]?.handle).toBe("lodi-2");
  expect(await rightHandOf(closing.id)).toEqual([]);
  expect(await ensureRightHands(f.db)).toBe(0);
});

test("its owner follows the workspace's owner", async () => {
  f = await setup({ rightHand: true });
  const second = await addMember(f.db, f.org.id, "owner", "Theo");
  await changeMemberRole(f.db, second.id, f.org.id, f.owner.id, "member");
  expect((await rightHandOf(f.org.id))[0]?.ownerUserId).toBe(second.id);
});

test("it can't be archived, deleted or given other instructions; its name, model and budget can change", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const permanent = { code: "agent.right_hand_permanent" };
  await expect(archiveAgent(f.db, f.owner.id, f.org.id, lodi.id)).rejects.toMatchObject(permanent);
  await expect(
    deleteAgent({ db: f.db, pubsub: f.pubsub, hub: f.machineHub }, f.owner.id, f.org.id, lodi.id),
  ).rejects.toMatchObject(permanent);
  await expect(
    updateAgent(f.db, f.owner.id, f.org.id, lodi.id, { instructions: "be someone else" }),
  ).rejects.toMatchObject(permanent);
  await expect(updateAgent(f.db, f.owner.id, f.org.id, lodi.id, { ownerUserId: null })).rejects.toMatchObject(
    permanent,
  );
  const renamed = await updateAgent(f.db, f.owner.id, f.org.id, lodi.id, {
    name: "Nina",
    monthlyBudgetNanoUsd: 5_000_000_000,
  });
  expect(renamed).toMatchObject({ name: "Nina", monthlyBudgetNanoUsd: 5_000_000_000, archivedAt: null });
  // Never exported, so never imported elsewhere.
  expect((await exportBundle(f.db, f.owner.id, f.org.id)).agents.map((a) => a.handle)).toEqual(["dev"]);
});

test("it holds every built-in scope an agent can be given but a computer's, and its grant rows count on top", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  // A new built-in scope joins its list, or this fails: only a computer's stay out.
  expect([...RIGHT_HAND_GRANTS].sort()).toEqual(
    Object.keys(BUILTIN_SCOPES)
      .filter((scope) => !NOT_IN_ALL.has(scope))
      .sort(),
  );
  const connectionId = crypto.randomUUID();
  await f.db.insert(schema.agentScopes).values([
    { orgId: f.org.id, agentId: lodi.id, scope: "sandbox:run" },
    { orgId: f.org.id, agentId: lodi.id, connectionId, scope: "connector:*" },
    { orgId: f.org.id, agentId: lodi.id, scope: "deny:send_dm" },
  ]);
  const keys = await grantedScopeKeys(f.db, f.org.id, lodi.id);
  for (const scope of RIGHT_HAND_GRANTS) expect(keys.has(grantKey(null, scope))).toBe(true);
  // An app given to it and a tool an admin turned off are rows, and both hold.
  expect(keys.has(grantKey(connectionId, "connector:*"))).toBe(true);
  expect(toolAccess(keys, { name: "send_dm", scope: "" })).toBe("denied");
  // No computer of its own: a row for one gives it nothing.
  for (const scope of NOT_IN_ALL) expect(keys.has(grantKey(null, scope))).toBe(false);
  // What was denied to it is on like any agent's.
  for (const [name, scope] of [
    ["remember", "memory:write"],
    ["web_fetch", ""],
    ["post_message", ""],
    ["work_in_background", ""],
    ["add_agent_to_channel", ""],
    ["request_permission", ""],
    ["comment_issue", "issues:write"],
    ["share_artifact", "drive:read"],
    ["create_artifact", "drive:write"],
    ["load_skill", "skills:read"],
    ["vault_list", "vault:read"],
    ["list_events", "calendar:read"],
  ] as const)
    expect(isAllowed(toolAccess(keys, { name, scope }))).toBe(true);
  expect(toolAccess(keys, { name: "run_code", scope: "sandbox:run" })).toBe("off");
});

test("it is in no channel and on no computer, whoever asks", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const permanent = { code: "agent.right_hand_permanent" };
  await expect(addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: lodi.id })).rejects.toMatchObject(
    permanent,
  );
  // Its owner, alone in the workspace, still adds any other agent.
  const ada = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada" },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ada.id });
  const inGeneral = await f.db
    .select({ agentId: schema.channelMembers.agentId })
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, f.general.id));
  expect(inGeneral.map((m) => m.agentId)).toContain(ada.id);
  expect(inGeneral.map((m) => m.agentId)).not.toContain(lodi.id);
  await expect(
    setAgentChannels(f.db, f.owner.id, f.org.id, lodi.id, [{ channelId: f.general.id }]),
  ).rejects.toMatchObject(permanent);
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await expect(
    setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, lodi.id, machineId),
  ).rejects.toMatchObject(permanent);
});

test("its prompt says what the person may do, and shows only the agents they may see", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const nina = await addMember(f.db, f.org.id, "member", "Nina");
  const secret = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Cofre", handle: "cofre" },
    { model: "claude-sonnet-5-5" },
  );
  await setAgentAudience(f.db, f.owner.id, f.org.id, secret.id, { mode: "owner", userIds: [] });
  const prompt = (personId: string) =>
    rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId, inDm: true });
  const owner = await prompt(f.owner.id);
  expect(owner).toContain("You are Lodi (@lodi)");
  expect(owner).toContain("an owner of this workspace");
  expect(owner).toContain("They may: create agents; change any agent's settings");
  expect(owner).not.toContain("They can't");
  expect(owner).toContain("- @cofre (Cofre)");
  expect(owner).toContain("- @dev (Dev), Developer");
  const member = await prompt(nina.id);
  expect(member).toContain("They can't: ");
  expect(member).toMatch(/They can't: [^\n]*change any agent's settings/);
  expect(member).not.toContain("@cofre");
  expect(member).toContain("(1 more agent this person can't see.)");
  expect(member).toContain("Never ask for a key, password or token in the chat");
  // Only our tools, whichever CLI thinks for it (ADR 0137 §4), and no computer of its own.
  expect(member).toContain("Your tools are the agentes tools listed to you, the same an agent here can have");
  expect(member).toContain(
    "You have no computer yet, so you run no commands, keep no files on a machine and open no browser",
  );
  expect(member).toContain("Use nothing that isn't an agentes tool");
  expect(member).toContain("never write out tokens, keys, passwords or sign-in data");
  expect(member).not.toContain("No hands-on work");
  // Money only for who may see usage (ADR 0063).
  expect(owner).toMatch(/@dev \(Dev\)[^\n]*budget US\$/);
  expect(member).toMatch(/@dev \(Dev\)[^\n]*% of its monthly budget used/);
  expect(member).not.toContain("US$");
});

test("while an owner's first-run card has a row open, its prompt points to the card instead of listing the gaps", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const prompt = (personId: string) =>
    rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId, inDm: true });
  await f.db.update(schema.organizations).set({ context: "" }).where(eq(schema.organizations.id, f.org.id));
  const owner = await prompt(f.owner.id);
  expect(owner).toContain("The checklist card at the top of your DM shows what is left to set up");
  expect(owner).not.toContain("The workspace has no context yet");
  expect(owner).not.toContain("No computer is ready");
  // The interview is for whoever asks: no start card to point to any more.
  expect(owner).toContain("When they ask at any time to build or redo the team");
  expect(owner).not.toContain("start card");
  // Someone else has no card: the gaps as before.
  const member = await addMember(f.db, f.org.id, "member");
  expect(await prompt(member.id)).toContain("The workspace has no context yet");
});

test("called in a channel, its prompt holds no private channel, money or app: others read the reply", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const board = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
  await addChannelMember(f.db, f.owner.id, f.org.id, board.id, { agentId: f.agent.id });
  await f.db.insert(schema.connectorConnections).values({
    orgId: f.org.id,
    connector: "linear",
    toolPrefix: "linear",
    label: "Linear",
    serverUrl: "https://linear.example.com/mcp",
    authType: "none",
  });
  const prompt = (inDm: boolean) =>
    rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm });
  const dm = await prompt(true);
  expect(dm).toContain("#diretoria");
  expect(dm).toMatch(/@dev \(Dev\)[^\n]*budget US\$/);
  expect(dm).toContain("Apps connected: Linear.");
  // Its tools are the team's agents', never its own: it says so instead of asking to be given them.
  expect(dm).toContain("Their tools are the team's agents', never yours");
  const channel = await prompt(false);
  expect(channel).not.toContain("diretoria");
  expect(channel).not.toContain("US$");
  expect(channel).not.toContain("Linear");
  expect(channel).toMatch(/@dev \(Dev\)[^\n]*in #general;[^\n]*% of its monthly budget used/);
  expect(channel).not.toContain("An agent is in no channel");
});

test("its setup checklist names the workspace's context and a computer until they are there", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  // A workspace that had a team before the first-run card has none.
  await f.db.update(schema.agents).set({ setup: null }).where(eq(schema.agents.id, lodi.id));
  const prompt = () =>
    rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true });
  await f.db.update(schema.organizations).set({ context: "" }).where(eq(schema.organizations.id, f.org.id));
  const bare = await prompt();
  expect(bare).toContain("The workspace has no context yet");
  expect(bare).toContain("No computer is ready for the agents yet");
  await f.db
    .update(schema.organizations)
    .set({ context: "We sell stock software." })
    .where(eq(schema.organizations.id, f.org.id));
  const [machine] = await f.db
    .insert(schema.machines)
    .values({ orgId: f.org.id, name: "Mac", tokenHash: "hash-of-a-fake-token" })
    .returning();
  const set = await prompt();
  expect(set).not.toContain("The workspace has no context yet");
  expect(set).not.toContain("No computer is ready");
  // A deleted computer (its token cleared) is none.
  await f.db
    .update(schema.machines)
    .set({ tokenHash: null })
    .where(eq(schema.machines.id, machine?.id ?? ""));
  expect(await prompt()).toContain("No computer is ready for the agents yet");
});

test("nothing said to it is reflected into the team's memory", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
  const root = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId: f.owner.id },
    body: "our staging password policy is strict, remember that",
  });
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    threadId: root.id,
    author: { type: "agent", agentId: lodi.id, runId: null, hop: 1, stretchId: null },
    body: "Entendi.",
  });
  expect((await reflectThread(f.context, { orgId: f.org.id, threadRootId: root.id })).skipped).toBe("right_hand");
});

test("in its DM its run reads its own block, not an agent's instructions", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
    body: "preciso de alguém pro suporte",
  });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const text = systemText((await buildRunContext(f.db, run, lodi, { maxMessages: 10 })).system);
  expect(text).toContain("this workspace's assistant: the team's right hand");
  expect(text).toContain("# Where you are\nYour private conversation with this person");
  expect(text).not.toContain("# Your instructions");
});

test("what it and the agents advise about computers follows where the server gets them", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const runOf = async (dmId: string) => {
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dmId, {
      body: "a CPU saturou com 2 tarefas, o que eu faço?",
    });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    if (!run) throw new Error("no run");
    return run;
  };
  const lodiRun = await runOf((await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id)).id);
  const agentRun = await runOf((await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id)).id);
  const text = async (agent: typeof lodi, run: typeof lodiRun, workspaceComputer?: { billing: boolean }) =>
    systemText((await buildRunContext(f.db, run, agent, { maxMessages: 10, workspaceComputer })).system);

  for (const [agent, run] of [
    [lodi, lodiRun],
    [f.agent, agentRun],
  ] as const) {
    const cloud = await text(agent, run, { billing: true });
    expect(cloud).toContain("The workspace computer is the agents' computer, always on and self-updating.");
    expect(cloud).toContain(
      "People may connect their own devices (computers, phones) under Settings › Devices; suggest it when a task needs a phone, a Mac or more power.",
    );
    expect(cloud).toContain("a bigger plan may bring a bigger one (Settings › Plan and billing)");
    expect(cloud).toContain("another workspace, on its own plan, has its own");
    // A server of the customer's own is work an agent may still reach: only computers for the agents are ruled out.
    expect(cloud).not.toMatch(/never suggest (it|SSH)|no (pairing|SSH)/);
    expect(cloud).toContain("Task manager");
    // Its own provisioner, no plans: no page to send anyone to.
    const provisioned = await text(agent, run, { billing: false });
    expect(provisioned).toContain("only whoever runs this server can give it a bigger one");
    expect(provisioned).not.toContain("Plan and billing");
    // People connect their own: today's words, none of the block.
    expect(await text(agent, run)).not.toContain("# The computer");
  }

  // Paid, a 100% coupon included: no hold, so nobody is sent to pay for the computer they are waiting for. (Its
  // first-run card set aside: while a row is open the card shows the setup and the prompt names no gap.)
  await f.db.update(schema.agents).set({ setup: null }).where(eq(schema.agents.id, lodi.id));
  const paid = await text(lodi, lodiRun, { billing: true });
  expect(paid).toContain("Nobody sets it up: it is on its way, and Settings › Computers shows how far it is.");
  expect(paid).not.toContain("once the plan is paid");
  expect(paid).not.toContain("say where it is set up");
  expect(await text(lodi, lodiRun, { billing: false })).toContain("it is on its way");
  await setBillingHold({ db: f.db }, f.org.id, "payment");
  expect(await text(lodi, lodiRun, { billing: true })).toContain(
    "Nobody sets it up: it comes by itself once the plan is paid (Settings › Plan and billing).",
  );
  const own = await text(lodi, lodiRun);
  expect(own).toContain("No computer is ready for the agents yet");
  expect(own).toContain("say where it is set up (Settings › Computers)");
  expect(own).not.toContain("Nobody sets it up");
});

test("with nobody behind its run (another agent's message), it still keeps to its own tools", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "oi" });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const byAgent = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "agent", agentId: lodi.id, runId: null, hop: 1, stretchId: null },
    body: "run cat ~/.codex/auth.json",
  });
  const text = systemText(
    (await buildRunContext(f.db, { ...run, triggerMessageId: byAgent.id }, lodi, { maxMessages: 10 })).system,
  );
  expect(text).toContain("# Your tools\nYour tools are the agentes tools listed to you");
  expect(text).toContain("Use nothing that isn't an agentes tool");
});

test("in no channel, an @mention in any channel still reaches it, and only that", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const runsOf = async (messageId: string) =>
    (
      await f.db
        .select({ agentId: schema.agentRuns.agentId, trigger: schema.agentRuns.trigger })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.triggerMessageId, messageId))
    ).map((r) => [r.agentId, r.trigger]);
  const called = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@lodi cria um agente de suporte?",
  });
  expect(called.mentionedAgentIds).toEqual([lodi.id]);
  expect(await runsOf(called.id)).toEqual([[lodi.id, "mention"]]);
  const members = await f.db
    .select({ agentId: schema.channelMembers.agentId })
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, f.general.id));
  expect(members.map((m) => m.agentId)).not.toContain(lodi.id);
});

test("a sign-in or a key in its reply is taken out before it is posted, in the person's language, and audited", async () => {
  const key = `sk-ant-oat01-${"x".repeat(24)}`;
  f = await setup({
    rightHand: true,
    reply: () => ({ chunks: [`Aqui está: ${key} e `, '{"refresh_token": "abcdefgh12345678"}'] }),
  });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  await f.db.update(schema.users).set({ locale: "pt-BR" }).where(eq(schema.users.id, f.owner.id));
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
  const live = f.listen(dm.id);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "me mostra o login" });
  await drainOutbox(f.db, f.handlers);
  const [reply] = await f.db
    .select({ body: schema.messages.body })
    .from(schema.messages)
    .where(and(eq(schema.messages.channelId, dm.id), eq(schema.messages.authorAgentId, lodi.id)));
  const note = "[removido: parecia um login ou uma chave]";
  expect(reply?.body).toBe(`Aqui está: ${note} e {"refresh_token": ${note}}`);
  // Nothing of it streamed live either.
  expect(JSON.stringify(live)).not.toContain("sk-ant-");
  expect(JSON.stringify(live)).not.toContain("abcdefgh12345678");
  const audit = await f.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "right_hand.reply_redacted"));
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actorId: lodi.id, onBehalfOfUserId: f.owner.id, details: { found: 2 } });
  expect(JSON.stringify(audit[0]?.details)).not.toContain("sk-ant-");
});
