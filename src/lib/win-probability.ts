import type {
  MatchDto,
  MatchTimelineDto,
  ParticipantDto,
  TimelineEventDto,
} from "@/lib/types/riot";

interface TeamState {
  kills: number;
  towers: number;
  dragons: number;
  inhibitors: number;
  baronExpiresAt: number;
  elderExpiresAt: number;
}

interface EventEvaluation {
  event: TimelineEventDto;
  killerTeamId: number | null;
  description: string;
  involvedPlayers: string[];
}

export interface GameState {
  minute: number;
  goldDiff: number;
  xpDiff: number;
  killDiff: number;
  towerDiff: number;
  dragonDiff: number;
  baronActive: boolean;
  elderActive: boolean;
  inhibsDown: number;
}

export interface KeyEvent {
  timestamp: number;
  type: string;
  description: string;
  winProbBefore: number;
  winProbAfter: number;
  delta: number;
  involvedPlayers: string[];
}

export interface WinProbPoint {
  minute: number;
  timestamp: number;
  winProbability: number;
  gameState: GameState;
  events: KeyEvent[];
}

export interface KeyMoment {
  timestamp: number;
  minute: number;
  events: KeyEvent[];
  totalDelta: number;
  description: string;
  type: "positive" | "negative";
}

const TEAM_IDS = [100, 200] as const;
const BARON_BUFF_DURATION_MS = 3 * 60 * 1000;
const ELDER_BUFF_DURATION_MS = Math.floor(2.5 * 60 * 1000);

function getParticipantByPuuid(match: MatchDto, puuid: string): ParticipantDto | undefined {
  return match.info.participants.find((participant) => participant.puuid === puuid);
}

function getChampionNameByParticipantId(
  participantId: number | undefined,
  championByParticipantId: Map<number, string>,
): string {
  if (!participantId || participantId <= 0) {
    return "Unknown";
  }

  return championByParticipantId.get(participantId) ?? "Unknown";
}

function getTeamIdByParticipantId(
  participantId: number | undefined,
  teamByParticipantId: Map<number, number>,
): number | null {
  if (!participantId || participantId <= 0) {
    return null;
  }

  return teamByParticipantId.get(participantId) ?? null;
}

function roleLabel(teamId: number | null): string {
  if (teamId === 100) {
    return "Blue team";
  }

  if (teamId === 200) {
    return "Red team";
  }

  return "A team";
}

function formatMonsterName(event: TimelineEventDto): string {
  if (event.monsterType === "DRAGON") {
    return event.monsterSubType?.replace(/_/g, " ") ?? "Dragon";
  }

  if (event.monsterType === "BARON_NASHOR") {
    return "Baron Nashor";
  }

  if (event.monsterType === "RIFTHERALD") {
    return "Rift Herald";
  }

  if (event.monsterType === "ELDER_DRAGON") {
    return "Elder Dragon";
  }

  return event.monsterType?.replace(/_/g, " ") ?? "Elite monster";
}

function formatBuildingName(event: TimelineEventDto): string {
  const tower = event.towerType?.replace(/_/g, " ") ?? "building";
  const lane = event.laneType?.replace(/_/g, " ") ?? "lane";
  return `${tower} in ${lane}`;
}

function getKillStreakText(event: TimelineEventDto): string {
  const multiKillLength =
    typeof event.multiKillLength === "number" ? event.multiKillLength : null;

  if (!multiKillLength || multiKillLength < 2) {
    return "";
  }

  const labels: Record<number, string> = {
    2: "double kill",
    3: "triple kill",
    4: "quadra kill",
    5: "penta kill",
  };

  return labels[multiKillLength] ? ` (${labels[multiKillLength]})` : "";
}

function evaluateEvent(params: {
  event: TimelineEventDto;
  teamByParticipantId: Map<number, number>;
  championByParticipantId: Map<number, string>;
}): EventEvaluation {
  const { event, teamByParticipantId, championByParticipantId } = params;

  const killerTeamId =
    getTeamIdByParticipantId(event.killerId, teamByParticipantId) ??
    (typeof event.teamId === "number" ? event.teamId : null);
  const killerChampion = getChampionNameByParticipantId(
    event.killerId,
    championByParticipantId,
  );
  const victimChampion = getChampionNameByParticipantId(
    event.victimId,
    championByParticipantId,
  );
  const assistingChampions =
    event.assistingParticipantIds?.map((id) =>
      getChampionNameByParticipantId(id, championByParticipantId),
    ) ?? [];

  let description = `${event.type.replace(/_/g, " ")} event`;

  if (event.type === "CHAMPION_KILL") {
    description = `${killerChampion} killed ${victimChampion}${getKillStreakText(event)}`;
  } else if (event.type === "BUILDING_KILL") {
    description = `${roleLabel(killerTeamId)} destroyed ${formatBuildingName(event)}`;
  } else if (event.type === "ELITE_MONSTER_KILL") {
    description = `${roleLabel(killerTeamId)} killed ${formatMonsterName(event)}`;
  } else if (event.type === "TURRET_PLATE_DESTROYED") {
    description = `${roleLabel(killerTeamId)} took a turret plate`;
  } else if (event.type === "ITEM_PURCHASED" && typeof event.itemId === "number") {
    description = `${killerChampion} purchased item ${event.itemId}`;
  } else if (event.type === "WARD_PLACED") {
    description = `${killerChampion} placed a ${event.wardType ?? "ward"}`;
  }

  const involvedPlayers = [killerChampion, victimChampion, ...assistingChampions].filter(
    (name) => name !== "Unknown",
  );

  return {
    event,
    killerTeamId,
    description,
    involvedPlayers: Array.from(new Set(involvedPlayers)),
  };
}

function updateTeamStateFromEvent(
  eventEval: EventEvaluation,
  teamState: Record<number, TeamState>,
) {
  const { event, killerTeamId } = eventEval;

  if (event.type === "CHAMPION_KILL" && killerTeamId) {
    teamState[killerTeamId].kills += 1;
    return;
  }

  if (event.type === "BUILDING_KILL" && killerTeamId) {
    if (event.buildingType === "TOWER_BUILDING") {
      teamState[killerTeamId].towers += 1;
    }

    if (event.buildingType === "INHIBITOR_BUILDING") {
      teamState[killerTeamId].inhibitors += 1;
    }
    return;
  }

  if (event.type !== "ELITE_MONSTER_KILL" || !killerTeamId) {
    return;
  }

  if (event.monsterType === "DRAGON") {
    teamState[killerTeamId].dragons += 1;
    return;
  }

  if (event.monsterType === "ELDER_DRAGON") {
    teamState[killerTeamId].elderExpiresAt = event.timestamp + ELDER_BUFF_DURATION_MS;
    return;
  }

  if (event.monsterType === "BARON_NASHOR") {
    teamState[killerTeamId].baronExpiresAt = event.timestamp + BARON_BUFF_DURATION_MS;
  }
}

function calculateDiffFromFrame(frame: MatchTimelineDto["info"]["frames"][number], teamId: number) {
  const enemyTeamId = teamId === 100 ? 200 : 100;

  let teamGold = 0;
  let enemyGold = 0;
  let teamXp = 0;
  let enemyXp = 0;

  for (const participantFrame of Object.values(frame.participantFrames)) {
    const currentTeamId = participantFrame.participantId <= 5 ? 100 : 200;

    if (currentTeamId === teamId) {
      teamGold += participantFrame.totalGold;
      teamXp += participantFrame.xp;
    } else if (currentTeamId === enemyTeamId) {
      enemyGold += participantFrame.totalGold;
      enemyXp += participantFrame.xp;
    }
  }

  return {
    goldDiff: teamGold - enemyGold,
    xpDiff: teamXp - enemyXp,
  };
}

export function calculateWinProbability(state: GameState): number {
  const goldFactor = state.goldDiff / (1500 + state.minute * 100);
  const killFactor = state.killDiff * 0.02;
  const towerFactor = state.towerDiff * 0.04;
  const dragonFactor = state.dragonDiff * 0.03;
  const baronFactor = state.baronActive ? 0.12 : 0;
  const elderFactor = state.elderActive ? 0.2 : 0;
  const inhibFactor = state.inhibsDown * 0.1;
  const logit =
    goldFactor +
    killFactor +
    towerFactor +
    dragonFactor +
    baronFactor +
    elderFactor +
    inhibFactor;

  return 1 / (1 + Math.exp(-logit));
}

export function computeMatchWinProbTimeline(
  match: MatchDto,
  timeline: MatchTimelineDto,
  playerPuuid: string,
): WinProbPoint[] {
  const playerParticipant = getParticipantByPuuid(match, playerPuuid);

  if (!playerParticipant) {
    return [];
  }

  const playerTeamId = playerParticipant.teamId;
  const enemyTeamId = playerTeamId === 100 ? 200 : 100;

  const championByParticipantId = new Map<number, string>();
  const teamByParticipantId = new Map<number, number>();

  for (const participant of match.info.participants) {
    championByParticipantId.set(participant.participantId, participant.championName);
    teamByParticipantId.set(participant.participantId, participant.teamId);
  }

  const teamState: Record<number, TeamState> = {
    100: {
      kills: 0,
      towers: 0,
      dragons: 0,
      inhibitors: 0,
      baronExpiresAt: 0,
      elderExpiresAt: 0,
    },
    200: {
      kills: 0,
      towers: 0,
      dragons: 0,
      inhibitors: 0,
      baronExpiresAt: 0,
      elderExpiresAt: 0,
    },
  };

  const winProbTimeline: WinProbPoint[] = [];
  let previousProbability = 0.5;

  const frames = [...timeline.info.frames].sort((a, b) => a.timestamp - b.timestamp);

  for (const frame of frames) {
    const frameEvents = [...frame.events].sort((a, b) => a.timestamp - b.timestamp);
    const evaluatedEvents = frameEvents.map((event) =>
      evaluateEvent({ event, teamByParticipantId, championByParticipantId }),
    );

    for (const eventEval of evaluatedEvents) {
      updateTeamStateFromEvent(eventEval, teamState);
    }

    const diff = calculateDiffFromFrame(frame, playerTeamId);

    const gameState: GameState = {
      minute: Math.floor(frame.timestamp / 60_000),
      goldDiff: diff.goldDiff,
      xpDiff: diff.xpDiff,
      killDiff: teamState[playerTeamId].kills - teamState[enemyTeamId].kills,
      towerDiff: teamState[playerTeamId].towers - teamState[enemyTeamId].towers,
      dragonDiff: teamState[playerTeamId].dragons - teamState[enemyTeamId].dragons,
      baronActive: teamState[playerTeamId].baronExpiresAt > frame.timestamp,
      elderActive: teamState[playerTeamId].elderExpiresAt > frame.timestamp,
      inhibsDown: teamState[playerTeamId].inhibitors,
    };

    const probability = calculateWinProbability(gameState);
    const frameDelta = probability - previousProbability;
    const impactfulEvents = evaluatedEvents.filter((eventEval) =>
      ["CHAMPION_KILL", "BUILDING_KILL", "ELITE_MONSTER_KILL"].includes(
        eventEval.event.type,
      ),
    );
    const eventsForPoint = impactfulEvents.length > 0 ? impactfulEvents : evaluatedEvents;

    const eventShare =
      eventsForPoint.length > 0 ? frameDelta / eventsForPoint.length : 0;
    let rollingBefore = previousProbability;

    const keyEvents: KeyEvent[] = eventsForPoint.map((eventEval) => {
      const winProbBefore = rollingBefore;
      const winProbAfter = Math.max(
        0,
        Math.min(1, winProbBefore + eventShare),
      );
      rollingBefore = winProbAfter;

      return {
        timestamp: eventEval.event.timestamp,
        type: eventEval.event.type,
        description: eventEval.description,
        winProbBefore,
        winProbAfter,
        delta: winProbAfter - winProbBefore,
        involvedPlayers: eventEval.involvedPlayers,
      };
    });

    winProbTimeline.push({
      minute: gameState.minute,
      timestamp: frame.timestamp,
      winProbability: probability,
      gameState,
      events: keyEvents,
    });

    previousProbability = probability;
  }

  return winProbTimeline;
}

function buildMomentDescription(events: KeyEvent[], totalDelta: number): string {
  if (events.length === 0) {
    return `Win probability swing of ${(totalDelta * 100).toFixed(1)}%`;
  }

  const eventSummary = events.slice(0, 2).map((event) => event.description).join("; ");
  return `${eventSummary} (${(totalDelta * 100).toFixed(1)}% swing)`;
}

export function identifyKeyMoments(
  timeline: WinProbPoint[],
  topN = 5,
): KeyMoment[] {
  if (timeline.length < 2) {
    return [];
  }

  const groupedByMinute = new Map<number, { totalDelta: number; events: KeyEvent[] }>();

  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1];
    const current = timeline[index];
    const minuteDelta = current.winProbability - previous.winProbability;

    const existing = groupedByMinute.get(current.minute) ?? { totalDelta: 0, events: [] };
    existing.totalDelta += minuteDelta;

    const majorEvents = current.events.filter((event) => Math.abs(event.delta) >= 0.02);
    if (majorEvents.length > 0) {
      existing.events.push(...majorEvents);
      existing.totalDelta = majorEvents.reduce((sum, event) => sum + event.delta, 0);
    }

    groupedByMinute.set(current.minute, existing);
  }

  const keyMoments: KeyMoment[] = Array.from(groupedByMinute.entries())
    .map(([minute, data]) => {
      const point = timeline.find((entry) => entry.minute === minute) ?? timeline[0];
      const totalDelta = data.totalDelta;
      const sortedEvents = [...data.events].sort(
        (a, b) => Math.abs(b.delta) - Math.abs(a.delta),
      );
      const momentType: KeyMoment["type"] =
        totalDelta >= 0 ? "positive" : "negative";

      return {
        timestamp: point.timestamp,
        minute,
        events: sortedEvents,
        totalDelta,
        description: buildMomentDescription(sortedEvents, totalDelta),
        type: momentType,
      };
    })
    .sort((a, b) => Math.abs(b.totalDelta) - Math.abs(a.totalDelta))
    .slice(0, topN);

  return keyMoments;
}

// Compatibility export for earlier scaffolding.
export async function calculateWinProbabilityTimeline(
  frames: MatchTimelineDto["info"]["frames"],
): Promise<Array<{ minute: number; winProbability: number; source: "heuristic" }>> {
  const teamByParticipantId = new Map<number, number>();

  for (const teamId of TEAM_IDS) {
    const start = teamId === 100 ? 1 : 6;
    const end = teamId === 100 ? 5 : 10;

    for (let participantId = start; participantId <= end; participantId += 1) {
      teamByParticipantId.set(participantId, teamId);
    }
  }

  const stateByTeam: Record<number, TeamState> = {
    100: {
      kills: 0,
      towers: 0,
      dragons: 0,
      inhibitors: 0,
      baronExpiresAt: 0,
      elderExpiresAt: 0,
    },
    200: {
      kills: 0,
      towers: 0,
      dragons: 0,
      inhibitors: 0,
      baronExpiresAt: 0,
      elderExpiresAt: 0,
    },
  };

  const points: Array<{ minute: number; winProbability: number; source: "heuristic" }> = [];

  for (const frame of frames) {
    const eventEvals = frame.events.map((event) =>
      evaluateEvent({
        event,
        teamByParticipantId,
        championByParticipantId: new Map<number, string>(),
      }),
    );
    for (const eventEval of eventEvals) {
      updateTeamStateFromEvent(eventEval, stateByTeam);
    }

    const diff = calculateDiffFromFrame(frame, 100);
    const state: GameState = {
      minute: Math.floor(frame.timestamp / 60_000),
      goldDiff: diff.goldDiff,
      xpDiff: diff.xpDiff,
      killDiff: stateByTeam[100].kills - stateByTeam[200].kills,
      towerDiff: stateByTeam[100].towers - stateByTeam[200].towers,
      dragonDiff: stateByTeam[100].dragons - stateByTeam[200].dragons,
      baronActive: stateByTeam[100].baronExpiresAt > frame.timestamp,
      elderActive: stateByTeam[100].elderExpiresAt > frame.timestamp,
      inhibsDown: stateByTeam[100].inhibitors,
    };

    points.push({
      minute: state.minute,
      winProbability: calculateWinProbability(state),
      source: "heuristic",
    });
  }

  return points;
}
