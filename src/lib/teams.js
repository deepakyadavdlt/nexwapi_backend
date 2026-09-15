import { prisma } from "./prisma.js";

function agentBrief(a) {
  if (!a) return null;
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    role: a.role,
    color: a.color,
    kind: a.kind,
  };
}

export async function serializeTeam(team, agentsById) {
  const members = (team.agents || []).map(agentBrief);
  const leadIds = Array.isArray(team.leadIds) ? team.leadIds : [];
  const leads = leadIds.map((id) => agentsById.get(id) || members.find((m) => m.id === id)).filter(Boolean);
  return {
    id: team.id,
    name: team.name,
    leadIds,
    leads,
    members,
    memberCount: members.length,
    agentCount: members.length,
    createdAt: team.createdAt instanceof Date ? team.createdAt.getTime() : team.createdAt,
    updatedAt: team.updatedAt instanceof Date ? team.updatedAt.getTime() : team.updatedAt,
  };
}

export async function listTeamsDetailed(companyId, { q } = {}) {
  const where = {
    companyId,
    ...(q ? { name: { contains: String(q).trim(), mode: "insensitive" } } : {}),
  };
  const teams = await prisma.team.findMany({
    where,
    include: { agents: { orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });
  const allAgents = await prisma.agent.findMany({ where: { companyId } });
  const byId = new Map(allAgents.map((a) => [a.id, agentBrief(a)]));
  return Promise.all(teams.map((t) => serializeTeam(t, byId)));
}

export async function getTeamDetailed(companyId, teamId) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId },
    include: { agents: { orderBy: { name: "asc" } } },
  });
  if (!team) return null;
  const allAgents = await prisma.agent.findMany({ where: { companyId } });
  const byId = new Map(allAgents.map((a) => [a.id, agentBrief(a)]));
  return serializeTeam(team, byId);
}

/**
 * Create/update team and sync member teamId + leadIds.
 */
export async function upsertTeamMembers(companyId, teamId, { name, leadIds, memberIds } = {}) {
  const existing = teamId
    ? await prisma.team.findFirst({ where: { id: teamId, companyId } })
    : null;
  if (teamId && !existing) {
    const err = new Error("Team not found");
    err.status = 404;
    throw err;
  }

  const leads = Array.isArray(leadIds) ? [...new Set(leadIds.map(String))] : existing?.leadIds || [];
  const members = Array.isArray(memberIds)
    ? [...new Set(memberIds.map(String))]
    : null;

  // Validate agent IDs belong to company
  const idsToCheck = [...new Set([...(members || []), ...leads])];
  if (idsToCheck.length) {
    const found = await prisma.agent.findMany({
      where: { companyId, id: { in: idsToCheck } },
      select: { id: true },
    });
    const ok = new Set(found.map((a) => a.id));
    for (const id of idsToCheck) {
      if (!ok.has(id)) {
        const err = new Error(`Unknown agent: ${id}`);
        err.status = 400;
        throw err;
      }
    }
  }

  let team;
  if (!existing) {
    const nm = String(name || "").trim();
    if (!nm) {
      const err = new Error("name required");
      err.status = 400;
      throw err;
    }
    team = await prisma.team.create({
      data: { companyId, name: nm, leadIds: leads },
    });
  } else {
    team = await prisma.team.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(leadIds !== undefined ? { leadIds: leads } : {}),
      },
    });
  }

  if (members) {
    // Unassign agents who left this team
    await prisma.agent.updateMany({
      where: { companyId, teamId: team.id, id: { notIn: members } },
      data: { teamId: null },
    });
    // Assign listed members (leads included in members if needed)
    const assign = [...new Set([...members, ...leads])];
    if (assign.length) {
      await prisma.agent.updateMany({
        where: { companyId, id: { in: assign } },
        data: { teamId: team.id },
      });
    }
  } else if (leads.length) {
    // Ensure leads are on the team
    await prisma.agent.updateMany({
      where: { companyId, id: { in: leads } },
      data: { teamId: team.id },
    });
  }

  return getTeamDetailed(companyId, team.id);
}

export function defaultTeamControls() {
  return {
    teamShowMembersInAssignee: false,
    teamLeadCanAssignContacts: true,
    teamLeadCanViewTeamContacts: true,
  };
}

export async function getTeamControls(companyId) {
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: {},
    create: { companyId, businessName: "Nexwapi" },
  });
  return {
    teamShowMembersInAssignee: s.teamShowMembersInAssignee === true,
    teamLeadCanAssignContacts: s.teamLeadCanAssignContacts !== false,
    teamLeadCanViewTeamContacts: s.teamLeadCanViewTeamContacts !== false,
  };
}

export async function updateTeamControls(companyId, patch = {}) {
  const data = {};
  if (patch.teamShowMembersInAssignee !== undefined) {
    data.teamShowMembersInAssignee = Boolean(patch.teamShowMembersInAssignee);
  }
  if (patch.teamLeadCanAssignContacts !== undefined) {
    data.teamLeadCanAssignContacts = Boolean(patch.teamLeadCanAssignContacts);
  }
  if (patch.teamLeadCanViewTeamContacts !== undefined) {
    data.teamLeadCanViewTeamContacts = Boolean(patch.teamLeadCanViewTeamContacts);
  }
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: data,
    create: { companyId, businessName: "Nexwapi", ...defaultTeamControls(), ...data },
  });
  return {
    teamShowMembersInAssignee: s.teamShowMembersInAssignee === true,
    teamLeadCanAssignContacts: s.teamLeadCanAssignContacts !== false,
    teamLeadCanViewTeamContacts: s.teamLeadCanViewTeamContacts !== false,
  };
}
