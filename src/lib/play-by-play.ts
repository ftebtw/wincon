import type {
  MatchDto,
  MatchTimelineDto,
  ParticipantDto,
  ParticipantFrameDto,
  TimelineEventDto,
} from "@/lib/types/riot";
import type { WinProbPoint } from "@/lib/win-probability";

export interface DeathMapPoint {
  id: string;
  x: number;
  y: number;
  timestamp: number;
  champion: string;
  type: "solo" | "ganked" | "teamfight" | "tower_dive";
  severity: "critical" | "major" | "minor" | "info";
}

export interface DeathMapData {
  deaths: DeathMapPoint[];
}

export interface WardMapPoint {
  id: string;
  x: number;
  y: number;
  timestamp: number;
  type: "placed" | "killed";
}

export interface WardMapData {
  wards: WardMapPoint[];
}

export interface AnalyzedEvent {
  id: string;
  timestamp: number;
  minute: number;
  type:
    | "death"
    | "kill"
    | "teamfight"
    | "objective"
    | "tower"
    | "item_purchase"
    | "recall"
    | "ward";
  description: string;
  involvedPlayers: {
    puuid: string;
    champion: string;
    role: "killer" | "victim" | "assister" | "participant";
  }[];
  position: { x: number; y: number };
  wpaBefore: number;
  wpaAfter: number;
  wpaDelta: number;
  context: {
    goldDiff: number;
    goldState: "ahead" | "even" | "behind";
    objectivesUp: string[];
    playerGold: number;
    playerLevel: number;
    opponentLevel: number;
  };
  aiRelevant: boolean;
  severity: "critical" | "major" | "minor" | "info";
}

export interface Teamfight {
  id: string;
  startTime: number;
  endTime: number;
  position: { x: number; y: number };
  blueKills: number;
  redKills: number;
  winner: "blue" | "red" | "trade";
  killOrder: {
    timestamp: number;
    victim: string;
    killer: string;
    deathPosition: { x: number; y: number };
  }[];
  initiator: string;
  objectiveAfter?: string;
  totalGoldSwing: number;
  wpaDelta: number;
  playerPerformance: {
    survived: boolean;
    kills: number;
    deaths: number;
    assists: number;
    damageDealt: number;
    positioning: "good" | "neutral" | "bad";
  };
}

export interface RecallEvent {
  timestamp: number;
  goldBeforeRecall: number;
  goldSpent: number;
  itemsPurchased: string[];
  timeAwayFromLane: number;
  csLostEstimate: number;
  wasEfficient: boolean;
  missedObjective: boolean;
}

export interface GoldEfficiencyEvent {
  timestamp: number;
  currentGold: number;
  minutesSinceLastPurchase: number;
  suggestion: string;
}

type CachedContext = {
  playerParticipantId: number;
  playerTeamId: number;
  playerChampion: string;
};

const MAP_MAX = 15_000;
const TEAMFIGHT_WINDOW_MS = 15_000;
const TEAMFIGHT_RADIUS = 3000;

function clampPosition(value: number): number {
  return Math.max(0, Math.min(MAP_MAX, value));
}

function averagePosition(positions: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (positions.length === 0) {
    return { x: 0, y: 0 };
  }

  const sum = positions.reduce(
    (acc, position) => ({ x: acc.x + position.x, y: acc.y + position.y }),
    { x: 0, y: 0 },
  );

  return {
    x: Math.round(sum.x / positions.length),
    y: Math.round(sum.y / positions.length),
  };
}

function euclideanDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function roleFromParticipant(participant: ParticipantDto): string {
  const byPosition: Record<string, string> = {
    TOP: "TOP",
    JUNGLE: "JUNGLE",
    MIDDLE: "MID",
    BOTTOM: "ADC",
    UTILITY: "SUPPORT",
  };

  if (participant.teamPosition && participant.teamPosition in byPosition) {
    return byPosition[participant.teamPosition];
  }

  if (participant.lane === "JUNGLE") return "JUNGLE";
  if (participant.lane === "MIDDLE") return "MID";
  if (participant.lane === "TOP") return "TOP";
  if (participant.lane === "BOTTOM" && participant.role === "DUO_SUPPORT") return "SUPPORT";
  if (participant.lane === "BOTTOM") return "ADC";
  return "UNKNOWN";
}

function severityFromDelta(delta: number): AnalyzedEvent["severity"] {
  const absolute = Math.abs(delta);
  if (absolute >= 0.12) return "critical";
  if (absolute >= 0.06) return "major";
  if (absolute >= 0.025) return "minor";
  return "info";
}

function objectivesSoon(minute: number): string[] {
  const upcoming: string[] = [];
  const minuteInCycle = minute % 5;
  if (minute >= 4 && minuteInCycle >= 3) upcoming.push("Dragon");
  if (minute >= 19 && minute % 6 >= 4) upcoming.push("Baron");
  if (minute >= 13 && minute % 5 >= 3) upcoming.push("Herald/Tower");
  return upcoming;
}

function nearestFrameAtOrBefore(
  timeline: MatchTimelineDto,
  timestamp: number,
): MatchTimelineDto["info"]["frames"][number] | null {
  let candidate: MatchTimelineDto["info"]["frames"][number] | null = null;
  for (const frame of timeline.info.frames) {
    if (frame.timestamp <= timestamp) {
      candidate = frame;
    } else {
      break;
    }
  }
  return candidate ?? timeline.info.frames[0] ?? null;
}

function nearestWinProbabilityAtOrBefore(
  timeline: WinProbPoint[],
  timestamp: number,
): WinProbPoint | null {
  let candidate: WinProbPoint | null = null;
  for (const point of timeline) {
    if (point.timestamp <= timestamp) {
      candidate = point;
    } else {
      break;
    }
  }
  return candidate ?? timeline[0] ?? null;
}

export class PlayByPlayAnalyzer {
  private participantById = new Map<number, ParticipantDto>();
  private puuidByParticipantId = new Map<number, string>();
  private teamByParticipantId = new Map<number, number>();
  private championByParticipantId = new Map<number, string>();
  private cachedContext: CachedContext | null = null;
  private cachedTimelineEvents: TimelineEventDto[] = [];

  analyzeAllEvents(
    match: MatchDto,
    timeline: MatchTimelineDto,
    playerPuuid: string,
    winProbTimeline: WinProbPoint[],
  ): {
    events: AnalyzedEvent[];
    teamfights: Teamfight[];
    recalls: RecallEvent[];
    goldEfficiency: GoldEfficiencyEvent[];
    deathMap: DeathMapData;
    wardMap: WardMapData;
    aiRelevantEvents: AnalyzedEvent[];
  } {
    const playerParticipant = match.info.participants.find(
      (participant) => participant.puuid === playerPuuid,
    );
    if (!playerParticipant) {
      return {
        events: [],
        teamfights: [],
        recalls: [],
        goldEfficiency: [],
        deathMap: { deaths: [] },
        wardMap: { wards: [] },
        aiRelevantEvents: [],
      };
    }

    this.participantById.clear();
    this.puuidByParticipantId.clear();
    this.teamByParticipantId.clear();
    this.championByParticipantId.clear();

    for (const participant of match.info.participants) {
      this.participantById.set(participant.participantId, participant);
      this.puuidByParticipantId.set(participant.participantId, participant.puuid);
      this.teamByParticipantId.set(participant.participantId, participant.teamId);
      this.championByParticipantId.set(participant.participantId, participant.championName);
    }

    this.cachedContext = {
      playerParticipantId: playerParticipant.participantId,
      playerTeamId: playerParticipant.teamId,
      playerChampion: playerParticipant.championName,
    };

    const allTimelineEvents = timeline.info.frames
      .flatMap((frame) => frame.events)
      .sort((a, b) => a.timestamp - b.timestamp);
    this.cachedTimelineEvents = allTimelineEvents;

    const teamfights = this.detectTeamfights(allTimelineEvents);
    const recalls = this.detectRecalls(timeline, playerParticipant.participantId);
    const goldEfficiency = this.detectGoldSitting(timeline, playerParticipant.participantId);
    const deathMap = this.buildDeathMap(allTimelineEvents, playerParticipant.participantId);
    const wardMap = this.buildWardMap(allTimelineEvents, playerParticipant.participantId);

    const opponent = match.info.participants.find(
      (participant) =>
        participant.teamId !== playerParticipant.teamId &&
        roleFromParticipant(participant) === roleFromParticipant(playerParticipant),
    );
    const opponentParticipantId = opponent?.participantId;

    const analyzedEvents: AnalyzedEvent[] = [];

    for (const event of allTimelineEvents) {
      const type = event.type;
      const isImportantGlobalType =
        type === "CHAMPION_KILL" || type === "ELITE_MONSTER_KILL" || type === "BUILDING_KILL";
      const isPlayerScoped =
        (type === "ITEM_PURCHASED" &&
          typeof event.participantId === "number" &&
          event.participantId === playerParticipant.participantId) ||
        ((type === "WARD_PLACED" || type === "WARD_KILL") &&
          this.isPlayerWardEvent(event, playerParticipant.participantId));
      if (!isImportantGlobalType && !isPlayerScoped) {
        continue;
      }

      const minute = Math.floor(event.timestamp / 60_000);
      const beforePoint = nearestWinProbabilityAtOrBefore(
        winProbTimeline,
        Math.max(0, event.timestamp - 1000),
      );
      const afterPoint = nearestWinProbabilityAtOrBefore(winProbTimeline, event.timestamp);

      const wpaBefore = beforePoint?.winProbability ?? 0.5;
      const wpaAfter = afterPoint?.winProbability ?? wpaBefore;
      const wpaDelta = wpaAfter - wpaBefore;

      const frame = nearestFrameAtOrBefore(timeline, event.timestamp);
      const playerFrame = frame?.participantFrames[String(playerParticipant.participantId)];
      const opponentFrame =
        opponentParticipantId && frame
          ? frame.participantFrames[String(opponentParticipantId)]
          : undefined;
      const goldDiff = afterPoint?.gameState.goldDiff ?? 0;
      const goldState: "ahead" | "even" | "behind" =
        goldDiff >= 1000 ? "ahead" : goldDiff <= -1000 ? "behind" : "even";

      const involvedPlayers = this.buildInvolvedPlayers(event);
      const defaultPosition = playerFrame?.position ?? { x: 0, y: 0 };
      const position = {
        x: clampPosition(event.position?.x ?? defaultPosition.x),
        y: clampPosition(event.position?.y ?? defaultPosition.y),
      };

      let analyzedType: AnalyzedEvent["type"] = "kill";
      let description = type.replace(/_/g, " ");
      if (type === "CHAMPION_KILL") {
        const killerChampion =
          typeof event.killerId === "number"
            ? this.championByParticipantId.get(event.killerId) ?? "Unknown"
            : "Unknown";
        const victimChampion =
          typeof event.victimId === "number"
            ? this.championByParticipantId.get(event.victimId) ?? "Unknown"
            : "Unknown";
        analyzedType = event.victimId === playerParticipant.participantId ? "death" : "kill";
        description = `${killerChampion} killed ${victimChampion}`;
      } else if (type === "ELITE_MONSTER_KILL") {
        analyzedType = "objective";
        const monster = event.monsterSubType ?? event.monsterType ?? "Objective";
        description = `${monster.replace(/_/g, " ")} secured`;
      } else if (type === "BUILDING_KILL") {
        analyzedType = "tower";
        const towerType = event.towerType ?? event.buildingType ?? "Structure";
        description = `${towerType.replace(/_/g, " ")} destroyed`;
      } else if (type === "ITEM_PURCHASED") {
        analyzedType = "item_purchase";
        description = `Purchased item ${event.itemId ?? "Unknown"}`;
      } else if (type === "WARD_PLACED" || type === "WARD_KILL") {
        analyzedType = "ward";
        description =
          type === "WARD_PLACED"
            ? `Placed ${event.wardType ?? "ward"}`
            : `Cleared ${event.wardType ?? "ward"}`;
      }

      let severity = severityFromDelta(wpaDelta);
      if (analyzedType === "death" && severity === "info") {
        severity = "major";
      }

      analyzedEvents.push({
        id: `evt-${event.timestamp}-${analyzedEvents.length + 1}`,
        timestamp: event.timestamp,
        minute,
        type: analyzedType,
        description,
        involvedPlayers,
        position,
        wpaBefore,
        wpaAfter,
        wpaDelta,
        context: {
          goldDiff,
          goldState,
          objectivesUp: objectivesSoon(minute),
          playerGold: playerFrame?.currentGold ?? 0,
          playerLevel: playerFrame?.level ?? 1,
          opponentLevel: opponentFrame?.level ?? 1,
        },
        aiRelevant:
          analyzedType === "death" ||
          analyzedType === "objective" ||
          analyzedType === "tower" ||
          severity === "critical" ||
          severity === "major",
        severity,
      });
    }

    for (const recall of recalls) {
      const beforePoint = nearestWinProbabilityAtOrBefore(
        winProbTimeline,
        Math.max(0, recall.timestamp - 1000),
      );
      const afterPoint = nearestWinProbabilityAtOrBefore(winProbTimeline, recall.timestamp);
      const frame = nearestFrameAtOrBefore(timeline, recall.timestamp);
      const playerFrame = frame?.participantFrames[String(playerParticipant.participantId)];
      const goldDiff = afterPoint?.gameState.goldDiff ?? 0;

      analyzedEvents.push({
        id: `recall-${recall.timestamp}`,
        timestamp: recall.timestamp,
        minute: Math.floor(recall.timestamp / 60_000),
        type: "recall",
        description:
          recall.wasEfficient
            ? `Efficient recall with ${recall.goldBeforeRecall}g`
            : `Inefficient recall timing with ${recall.goldBeforeRecall}g`,
        involvedPlayers: [
          {
            puuid: playerPuuid,
            champion: playerParticipant.championName,
            role: "participant",
          },
        ],
        position: {
          x: clampPosition(playerFrame?.position?.x ?? 0),
          y: clampPosition(playerFrame?.position?.y ?? 0),
        },
        wpaBefore: beforePoint?.winProbability ?? 0.5,
        wpaAfter: afterPoint?.winProbability ?? 0.5,
        wpaDelta: (afterPoint?.winProbability ?? 0.5) - (beforePoint?.winProbability ?? 0.5),
        context: {
          goldDiff,
          goldState: goldDiff >= 1000 ? "ahead" : goldDiff <= -1000 ? "behind" : "even",
          objectivesUp: objectivesSoon(Math.floor(recall.timestamp / 60_000)),
          playerGold: recall.goldBeforeRecall,
          playerLevel: playerFrame?.level ?? 1,
          opponentLevel: playerFrame?.level ?? 1,
        },
        aiRelevant: !recall.wasEfficient || recall.missedObjective,
        severity:
          !recall.wasEfficient && recall.missedObjective
            ? "major"
            : !recall.wasEfficient
              ? "minor"
              : "info",
      });
    }

    for (const goldEvent of goldEfficiency) {
      const beforePoint = nearestWinProbabilityAtOrBefore(
        winProbTimeline,
        Math.max(0, goldEvent.timestamp - 1000),
      );
      const afterPoint = nearestWinProbabilityAtOrBefore(winProbTimeline, goldEvent.timestamp);
      analyzedEvents.push({
        id: `gold-${goldEvent.timestamp}`,
        timestamp: goldEvent.timestamp,
        minute: Math.floor(goldEvent.timestamp / 60_000),
        type: "item_purchase",
        description: goldEvent.suggestion,
        involvedPlayers: [
          {
            puuid: playerPuuid,
            champion: playerParticipant.championName,
            role: "participant",
          },
        ],
        position: { x: 0, y: 0 },
        wpaBefore: beforePoint?.winProbability ?? 0.5,
        wpaAfter: afterPoint?.winProbability ?? 0.5,
        wpaDelta: (afterPoint?.winProbability ?? 0.5) - (beforePoint?.winProbability ?? 0.5),
        context: {
          goldDiff: afterPoint?.gameState.goldDiff ?? 0,
          goldState:
            (afterPoint?.gameState.goldDiff ?? 0) >= 1000
              ? "ahead"
              : (afterPoint?.gameState.goldDiff ?? 0) <= -1000
                ? "behind"
                : "even",
          objectivesUp: objectivesSoon(Math.floor(goldEvent.timestamp / 60_000)),
          playerGold: goldEvent.currentGold,
          playerLevel: 1,
          opponentLevel: 1,
        },
        aiRelevant: true,
        severity: "major",
      });
    }

    analyzedEvents.sort((a, b) => a.timestamp - b.timestamp);
    for (const fight of teamfights) {
      const before = nearestWinProbabilityAtOrBefore(winProbTimeline, fight.startTime)?.winProbability ?? 0.5;
      const after = nearestWinProbabilityAtOrBefore(winProbTimeline, fight.endTime)?.winProbability ?? before;
      fight.wpaDelta = after - before;
    }

    const aiRelevantEvents = this.selectAIRelevantEvents(analyzedEvents, teamfights);
    return {
      events: analyzedEvents,
      teamfights,
      recalls,
      goldEfficiency,
      deathMap,
      wardMap,
      aiRelevantEvents,
    };
  }

  detectTeamfights(events: TimelineEventDto[]): Teamfight[] {
    if (!this.cachedContext) {
      return [];
    }

    const killEvents = events
      .filter(
        (event) =>
          event.type === "CHAMPION_KILL" &&
          typeof event.timestamp === "number" &&
          event.position &&
          typeof event.victimId === "number",
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    const fights: Teamfight[] = [];
    let index = 0;
    while (index < killEvents.length) {
      const seed = killEvents[index];
      if (!seed.position) {
        index += 1;
        continue;
      }
      const cluster: TimelineEventDto[] = [seed];
      let endIndex = index;

      for (let lookahead = index + 1; lookahead < killEvents.length; lookahead += 1) {
        const candidate = killEvents[lookahead];
        if (!candidate.position || !seed.position) {
          continue;
        }
        if (candidate.timestamp - seed.timestamp > TEAMFIGHT_WINDOW_MS) {
          break;
        }

        const center = averagePosition(
          cluster.map((entry) => ({
            x: entry.position?.x ?? seed.position?.x ?? 0,
            y: entry.position?.y ?? seed.position?.y ?? 0,
          })),
        );
        const distance = euclideanDistance(
          { x: candidate.position.x, y: candidate.position.y },
          center,
        );
        if (distance <= TEAMFIGHT_RADIUS) {
          cluster.push(candidate);
          endIndex = lookahead;
        }
      }

      if (cluster.length >= 2) {
        const fight = this.createTeamfightFromCluster(cluster);
        if (fight) {
          fights.push(fight);
        }
      }

      index = Math.max(index + 1, endIndex + 1);
    }

    return fights;
  }

  detectRecalls(timeline: MatchTimelineDto, playerParticipantId: number): RecallEvent[] {
    const recalls: RecallEvent[] = [];
    const playerFrames = timeline.info.frames
      .map((frame) => ({
        timestamp: frame.timestamp,
        frame: frame.participantFrames[String(playerParticipantId)],
      }))
      .filter(
        (entry): entry is { timestamp: number; frame: ParticipantFrameDto } =>
          Boolean(entry.frame),
      );

    if (playerFrames.length < 2) {
      return recalls;
    }

    const playerTeamId = this.teamByParticipantId.get(playerParticipantId) ?? 100;
    const fountain = playerTeamId === 100 ? { x: 400, y: 400 } : { x: 14_300, y: 14_300 };
    const isNearFountain = (position: { x: number; y: number }) =>
      euclideanDistance(position, fountain) <= 2500;

    const objectiveEvents = this.cachedTimelineEvents.filter(
      (event) => event.type === "ELITE_MONSTER_KILL" || event.type === "BUILDING_KILL",
    );

    for (let index = 1; index < playerFrames.length; index += 1) {
      const previous = playerFrames[index - 1];
      const current = playerFrames[index];

      if (!isNearFountain(current.frame.position) || isNearFountain(previous.frame.position)) {
        continue;
      }

      const recallTimestamp = current.timestamp;
      const purchases = this.cachedTimelineEvents
        .filter(
          (event) =>
            event.type === "ITEM_PURCHASED" &&
            event.participantId === playerParticipantId &&
            event.timestamp >= recallTimestamp &&
            event.timestamp <= recallTimestamp + 45_000,
        )
        .map((event) => `Item ${event.itemId ?? "Unknown"}`);

      const nextFrame = playerFrames[index + 1];
      const goldSpent = Math.max(
        0,
        (previous.frame.currentGold ?? previous.frame.totalGold) -
          (nextFrame?.frame.currentGold ?? current.frame.currentGold),
      );

      const participant = this.participantById.get(playerParticipantId);
      const role = participant ? roleFromParticipant(participant) : "UNKNOWN";
      const travelTimeByRole: Record<string, number> = {
        TOP: 32,
        JUNGLE: 26,
        MID: 24,
        ADC: 30,
        SUPPORT: 30,
        UNKNOWN: 28,
      };
      const timeAwayFromLane = travelTimeByRole[role] ?? 28;

      const missedObjective = objectiveEvents.some(
        (event) =>
          event.timestamp >= recallTimestamp && event.timestamp <= recallTimestamp + 60_000,
      );

      recalls.push({
        timestamp: recallTimestamp,
        goldBeforeRecall: previous.frame.currentGold ?? previous.frame.totalGold,
        goldSpent,
        itemsPurchased: purchases,
        timeAwayFromLane,
        csLostEstimate: Math.round(timeAwayFromLane / 3),
        wasEfficient: (previous.frame.currentGold ?? previous.frame.totalGold) >= 900,
        missedObjective,
      });
    }

    return recalls;
  }

  detectGoldSitting(
    timeline: MatchTimelineDto,
    playerParticipantId: number,
  ): GoldEfficiencyEvent[] {
    const warnings: GoldEfficiencyEvent[] = [];
    const playerFrames = timeline.info.frames
      .map((frame) => ({
        timestamp: frame.timestamp,
        frame: frame.participantFrames[String(playerParticipantId)],
      }))
      .filter(
        (entry): entry is { timestamp: number; frame: ParticipantFrameDto } =>
          Boolean(entry.frame),
      );

    if (playerFrames.length === 0) {
      return warnings;
    }

    const purchaseTimes = this.cachedTimelineEvents
      .filter(
        (event) =>
          event.type === "ITEM_PURCHASED" && event.participantId === playerParticipantId,
      )
      .map((event) => event.timestamp)
      .sort((a, b) => a - b);

    let runStartIndex = -1;
    for (let index = 0; index < playerFrames.length; index += 1) {
      const currentGold = playerFrames[index].frame.currentGold;
      if (currentGold >= 1500) {
        if (runStartIndex === -1) {
          runStartIndex = index;
        }
      } else {
        runStartIndex = -1;
      }

      if (runStartIndex === -1) {
        continue;
      }
      const runLength = index - runStartIndex + 1;
      if (runLength < 3) {
        continue;
      }

      const timestamp = playerFrames[index].timestamp;
      const lastPurchase =
        [...purchaseTimes].reverse().find((purchaseTime) => purchaseTime <= timestamp) ?? 0;
      const minutesSinceLastPurchase = Number(
        ((timestamp - lastPurchase) / 60_000).toFixed(1),
      );
      warnings.push({
        timestamp,
        currentGold,
        minutesSinceLastPurchase,
        suggestion: `You sat on ${Math.round(currentGold)}g for ${minutesSinceLastPurchase} minutes - back and spend before next fight.`,
      });
      runStartIndex = -1;
    }

    return warnings;
  }

  buildDeathMap(events: TimelineEventDto[], playerParticipantId: number): DeathMapData {
    const deaths: DeathMapPoint[] = [];
    const killEvents = events.filter((event) => event.type === "CHAMPION_KILL");

    for (const event of killEvents) {
      if (event.victimId !== playerParticipantId || !event.position) {
        continue;
      }

      const timestamp = event.timestamp;
      const nearbyKills = killEvents.filter(
        (candidate) =>
          candidate.timestamp >= timestamp - TEAMFIGHT_WINDOW_MS &&
          candidate.timestamp <= timestamp + TEAMFIGHT_WINDOW_MS &&
          candidate.position &&
          euclideanDistance(candidate.position, event.position as { x: number; y: number }) <=
            TEAMFIGHT_RADIUS,
      ).length;
      const assistingCount = event.assistingParticipantIds?.length ?? 0;

      let type: DeathMapPoint["type"] = "solo";
      if (nearbyKills >= 3) {
        type = "teamfight";
      } else if (assistingCount >= 1) {
        type = "ganked";
      }

      const playerTeamId = this.teamByParticipantId.get(playerParticipantId) ?? 100;
      const killerTeamId =
        typeof event.killerId === "number"
          ? this.teamByParticipantId.get(event.killerId)
          : undefined;
      const inEnemyHalf =
        playerTeamId === 100
          ? event.position.x + event.position.y > 16_500
          : event.position.x + event.position.y < 13_500;
      if (killerTeamId && killerTeamId !== playerTeamId && inEnemyHalf) {
        type = "tower_dive";
      }

      deaths.push({
        id: `death-${timestamp}-${deaths.length + 1}`,
        x: clampPosition(event.position.x),
        y: clampPosition(event.position.y),
        timestamp,
        champion:
          this.championByParticipantId.get(playerParticipantId) ??
          this.cachedContext?.playerChampion ??
          "Unknown",
        type,
        severity: nearbyKills >= 3 || assistingCount >= 1 ? "major" : "minor",
      });
    }

    return { deaths };
  }

  buildWardMap(events: TimelineEventDto[], playerParticipantId: number): WardMapData {
    const wards: WardMapPoint[] = [];
    for (const event of events) {
      if (!event.position) {
        continue;
      }

      if (event.type === "WARD_PLACED" && this.isPlayerWardEvent(event, playerParticipantId)) {
        wards.push({
          id: `ward-place-${event.timestamp}-${wards.length + 1}`,
          x: clampPosition(event.position.x),
          y: clampPosition(event.position.y),
          timestamp: event.timestamp,
          type: "placed",
        });
      }

      if (event.type === "WARD_KILL" && event.killerId === playerParticipantId) {
        wards.push({
          id: `ward-kill-${event.timestamp}-${wards.length + 1}`,
          x: clampPosition(event.position.x),
          y: clampPosition(event.position.y),
          timestamp: event.timestamp,
          type: "killed",
        });
      }
    }
    return { wards };
  }

  selectAIRelevantEvents(events: AnalyzedEvent[], teamfights: Teamfight[]): AnalyzedEvent[] {
    const severityRank: Record<AnalyzedEvent["severity"], number> = {
      critical: 4,
      major: 3,
      minor: 2,
      info: 1,
    };

    const teamfightRelatedEventIds = new Set<string>();
    for (const fight of teamfights) {
      if (
        fight.playerPerformance.positioning === "bad" ||
        !fight.playerPerformance.survived ||
        Math.abs(fight.wpaDelta) >= 0.06
      ) {
        for (const event of events) {
          if (
            event.timestamp >= fight.startTime &&
            event.timestamp <= fight.endTime &&
            (event.type === "death" || event.type === "kill")
          ) {
            teamfightRelatedEventIds.add(event.id);
          }
        }
      }
    }

    return [...events]
      .filter((event) => {
        if (teamfightRelatedEventIds.has(event.id)) {
          return true;
        }
        if (event.type === "death") {
          return true;
        }
        if (event.type === "recall") {
          return event.severity !== "info";
        }
        if (event.type === "item_purchase" && event.description.includes("sat on")) {
          return true;
        }
        if (event.type === "objective" || event.type === "tower") {
          return Math.abs(event.wpaDelta) >= 0.03;
        }
        return event.aiRelevant;
      })
      .sort((a, b) => {
        const bySeverity = severityRank[b.severity] - severityRank[a.severity];
        if (bySeverity !== 0) {
          return bySeverity;
        }
        const byWpa = Math.abs(b.wpaDelta) - Math.abs(a.wpaDelta);
        if (byWpa !== 0) {
          return byWpa;
        }
        return a.timestamp - b.timestamp;
      })
      .slice(0, 10)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  private createTeamfightFromCluster(cluster: TimelineEventDto[]): Teamfight | null {
    if (!this.cachedContext || cluster.length < 2) {
      return null;
    }

    const killOrder = cluster.map((event) => {
      const victimChampion =
        typeof event.victimId === "number"
          ? this.championByParticipantId.get(event.victimId) ?? "Unknown"
          : "Unknown";
      const killerChampion =
        typeof event.killerId === "number"
          ? this.championByParticipantId.get(event.killerId) ?? "Unknown"
          : "Unknown";

      return {
        timestamp: event.timestamp,
        victim: victimChampion,
        killer: killerChampion,
        deathPosition: {
          x: clampPosition(event.position?.x ?? 0),
          y: clampPosition(event.position?.y ?? 0),
        },
      };
    });

    let blueKills = 0;
    let redKills = 0;
    let playerKills = 0;
    let playerDeaths = 0;
    let playerAssists = 0;
    let playerDiedAt: number | null = null;
    let totalGoldSwing = 0;

    for (const event of cluster) {
      if (typeof event.victimId === "number") {
        const victimTeam = this.teamByParticipantId.get(event.victimId);
        if (victimTeam === 100) {
          redKills += 1;
        } else if (victimTeam === 200) {
          blueKills += 1;
        }

        if (event.victimId === this.cachedContext.playerParticipantId) {
          playerDeaths += 1;
          if (!playerDiedAt) {
            playerDiedAt = event.timestamp;
          }
        }
      }

      if (event.killerId === this.cachedContext.playerParticipantId) {
        playerKills += 1;
      }
      if (
        Array.isArray(event.assistingParticipantIds) &&
        event.assistingParticipantIds.includes(this.cachedContext.playerParticipantId)
      ) {
        playerAssists += 1;
      }

      totalGoldSwing += 300 + (event.shutdownBounty ?? 0);
    }

    const winner: Teamfight["winner"] =
      blueKills === redKills ? "trade" : blueKills > redKills ? "blue" : "red";
    const startTime = cluster[0].timestamp;
    const endTime = cluster[cluster.length - 1].timestamp;
    const centerPosition = averagePosition(
      cluster.map((event) => ({
        x: clampPosition(event.position?.x ?? 0),
        y: clampPosition(event.position?.y ?? 0),
      })),
    );

    const objectiveAfter = this.findObjectiveAfterFight(endTime, winner);
    const survived = playerDeaths === 0;
    const positioning: Teamfight["playerPerformance"]["positioning"] =
      survived
        ? "good"
        : playerDiedAt && playerDiedAt - startTime < 7000
          ? "bad"
          : "neutral";

    return {
      id: `fight-${startTime}-${endTime}`,
      startTime,
      endTime,
      position: centerPosition,
      blueKills,
      redKills,
      winner,
      killOrder,
      initiator:
        typeof cluster[0].killerId === "number"
          ? this.championByParticipantId.get(cluster[0].killerId) ?? "Unknown"
          : "Unknown",
      objectiveAfter,
      totalGoldSwing,
      wpaDelta: 0,
      playerPerformance: {
        survived,
        kills: playerKills,
        deaths: playerDeaths,
        assists: playerAssists,
        damageDealt: playerKills * 300 + playerAssists * 150,
        positioning,
      },
    };
  }

  private isPlayerWardEvent(event: TimelineEventDto, playerParticipantId: number): boolean {
    if (typeof event.creatorId === "number" && event.creatorId === playerParticipantId) {
      return true;
    }
    if (event.killerId === playerParticipantId) {
      return true;
    }
    if (event.participantId === playerParticipantId) {
      return true;
    }
    return false;
  }

  private buildInvolvedPlayers(
    event: TimelineEventDto,
  ): AnalyzedEvent["involvedPlayers"] {
    const involved: AnalyzedEvent["involvedPlayers"] = [];

    if (typeof event.killerId === "number") {
      involved.push({
        puuid: this.puuidByParticipantId.get(event.killerId) ?? "",
        champion: this.championByParticipantId.get(event.killerId) ?? "Unknown",
        role: "killer",
      });
    }
    if (typeof event.victimId === "number") {
      involved.push({
        puuid: this.puuidByParticipantId.get(event.victimId) ?? "",
        champion: this.championByParticipantId.get(event.victimId) ?? "Unknown",
        role: "victim",
      });
    }
    if (Array.isArray(event.assistingParticipantIds)) {
      for (const assisterId of event.assistingParticipantIds) {
        involved.push({
          puuid: this.puuidByParticipantId.get(assisterId) ?? "",
          champion: this.championByParticipantId.get(assisterId) ?? "Unknown",
          role: "assister",
        });
      }
    }
    if (
      involved.length === 0 &&
      typeof event.participantId === "number" &&
      this.participantById.has(event.participantId)
    ) {
      involved.push({
        puuid: this.puuidByParticipantId.get(event.participantId) ?? "",
        champion: this.championByParticipantId.get(event.participantId) ?? "Unknown",
        role: "participant",
      });
    }

    return involved;
  }

  private findObjectiveAfterFight(
    endTime: number,
    winner: Teamfight["winner"],
  ): string | undefined {
    if (winner === "trade") {
      return undefined;
    }

    const teamId = winner === "blue" ? 100 : 200;
    for (const event of this.cachedTimelineEvents) {
      if (event.timestamp < endTime || event.timestamp > endTime + 45_000) {
        continue;
      }
      const killerTeamId =
        typeof event.killerId === "number"
          ? this.teamByParticipantId.get(event.killerId)
          : event.teamId;
      if (killerTeamId !== teamId) {
        continue;
      }
      if (event.type === "ELITE_MONSTER_KILL") {
        return (event.monsterSubType ?? event.monsterType ?? "Objective").replace(/_/g, " ");
      }
      if (event.type === "BUILDING_KILL") {
        return (event.towerType ?? event.buildingType ?? "Tower").replace(/_/g, " ");
      }
    }
    return undefined;
  }
}

export const playByPlayAnalyzer = new PlayByPlayAnalyzer();
