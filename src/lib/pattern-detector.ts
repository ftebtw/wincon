import type { MatchDto, MatchTimelineDto, ParticipantDto, TimelineEventDto } from "@/lib/types/riot";
import { getAntiHealingCheck } from "@/lib/build-analyzer";

export interface StatPattern {
  type: string;
  frequency: number;
  occurrences: number;
  totalGames: number;
  severity: "high" | "medium" | "low";
  matchIds: string[];
  details: Record<string, unknown>;
  description: string;
}

export interface MatchWithData {
  match: MatchDto;
  timeline: MatchTimelineDto;
  playerPuuid: string;
}

export interface GameSummary {
  matchId: string;
  champion: string;
  role: string;
  result: "WIN" | "LOSS";
  kda: string;
  cs: number;
  duration: string;
  earlyDeaths: number;
  deathPositions: string;
  visionScore: number;
  wardsPlaced: number;
  firstItemTime: string;
  items: string;
  biggestMistake: string;
  allyCompTags: string;
  enemyCompTags: string;
  buildAppropriate: boolean;
}

interface BuildCoverage {
  requiresGrievous: boolean;
  builtGrievous: boolean;
  requiresMr: boolean;
  builtMr: boolean;
  requiresArmor: boolean;
  builtArmor: boolean;
  isAppropriate: boolean;
}

const HEALING_HEAVY_CHAMPIONS = new Set([
  "soraka",
  "yuumi",
  "sona",
  "aatrox",
  "dr mundo",
  "drmundo",
  "vladimir",
  "sylas",
  "warwick",
  "fiddlesticks",
  "swain",
  "maokai",
]);

const GRIEVOUS_WOUNDS_ITEM_IDS = new Set([3123, 3916, 3033, 3165, 3075, 6609]);
const MAGIC_RESIST_ITEM_IDS = new Set([3111, 3155, 3156, 3102, 4401, 2504, 8020, 6665]);
const ARMOR_ITEM_IDS = new Set([3047, 3075, 3143, 3068, 3071, 6662, 3742, 6333]);

const DRAGON_PIT_POSITION = { x: 9800, y: 4300 };
const BARON_PIT_POSITION = { x: 5000, y: 10400 };

const TURRET_POSITIONS: Record<100 | 200, Array<{ x: number; y: number }>> = {
  100: [
    { x: 981, y: 10441 },
    { x: 1512, y: 6699 },
    { x: 1169, y: 4287 },
    { x: 5846, y: 6396 },
    { x: 5048, y: 4812 },
    { x: 3651, y: 3696 },
    { x: 10504, y: 1029 },
    { x: 6919, y: 1483 },
    { x: 4281, y: 1253 },
  ],
  200: [
    { x: 4318, y: 13875 },
    { x: 7943, y: 13411 },
    { x: 10481, y: 13650 },
    { x: 8955, y: 8510 },
    { x: 9767, y: 10113 },
    { x: 11134, y: 11207 },
    { x: 13866, y: 4505 },
    { x: 13327, y: 8226 },
    { x: 13624, y: 10572 },
  ],
};

function normalizeChampionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function roleFromParticipant(participant: ParticipantDto): string {
  if (participant.teamPosition === "TOP") {
    return "TOP";
  }
  if (participant.teamPosition === "JUNGLE") {
    return "JUNGLE";
  }
  if (participant.teamPosition === "MIDDLE") {
    return "MID";
  }
  if (participant.teamPosition === "BOTTOM") {
    return "ADC";
  }
  if (participant.teamPosition === "UTILITY") {
    return "SUPPORT";
  }

  if (participant.lane === "TOP") {
    return "TOP";
  }
  if (participant.lane === "JUNGLE") {
    return "JUNGLE";
  }
  if (participant.lane === "MIDDLE") {
    return "MID";
  }
  if (participant.lane === "BOTTOM" && participant.role === "DUO_SUPPORT") {
    return "SUPPORT";
  }
  if (participant.lane === "BOTTOM") {
    return "ADC";
  }

  return "UNKNOWN";
}

function expectedVisionPerMinute(role: string): number {
  if (role === "SUPPORT") {
    return 1.6;
  }
  if (role === "JUNGLE") {
    return 1.1;
  }
  if (role === "MID") {
    return 0.9;
  }
  if (role === "ADC") {
    return 0.7;
  }
  if (role === "TOP") {
    return 0.8;
  }
  return 0.8;
}

function getPlayerParticipant(match: MatchDto, playerPuuid: string): ParticipantDto | null {
  return match.info.participants.find((participant) => participant.puuid === playerPuuid) ?? null;
}

function getLaneOpponent(match: MatchDto, player: ParticipantDto): ParticipantDto | null {
  const enemies = match.info.participants.filter((participant) => participant.teamId !== player.teamId);

  if (player.teamPosition) {
    const byPosition = enemies.find((participant) => participant.teamPosition === player.teamPosition);
    if (byPosition) {
      return byPosition;
    }
  }

  const role = roleFromParticipant(player);
  return enemies.find((participant) => roleFromParticipant(participant) === role) ?? enemies[0] ?? null;
}

function getParticipantFrameAtOrBefore(
  timeline: MatchTimelineDto,
  participantId: number,
  timestampMs: number,
) {
  const frame = [...timeline.info.frames]
    .filter((candidate) => candidate.timestamp <= timestampMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  return frame?.participantFrames[String(participantId)];
}

function getCsAtMinute(timeline: MatchTimelineDto, participantId: number, minute: number): number {
  const frame = getParticipantFrameAtOrBefore(timeline, participantId, minute * 60_000);
  if (!frame) {
    return 0;
  }

  return frame.minionsKilled + frame.jungleMinionsKilled;
}

function getMatchDurationMinutes(match: MatchDto): number {
  return Math.max(1, match.info.gameDuration / 60);
}

function getItemIds(participant: ParticipantDto): number[] {
  return [
    participant.item0,
    participant.item1,
    participant.item2,
    participant.item3,
    participant.item4,
    participant.item5,
    participant.item6,
  ].filter((itemId) => itemId > 0);
}

function severityFromFrequency(frequency: number): StatPattern["severity"] {
  if (frequency > 0.6) {
    return "high";
  }
  if (frequency > 0.4) {
    return "medium";
  }
  return "low";
}

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isNearTeamTurret(position: { x: number; y: number } | undefined, teamId: 100 | 200): boolean {
  if (!position) {
    return false;
  }

  return TURRET_POSITIONS[teamId].some((turret) => distance(position, turret) <= 1600);
}

function positionLabel(position: { x: number; y: number } | undefined): string {
  if (!position) {
    return "unknown";
  }

  if (distance(position, DRAGON_PIT_POSITION) <= 1800) {
    return "dragon_river";
  }
  if (distance(position, BARON_PIT_POSITION) <= 1800) {
    return "baron_river";
  }

  if (Math.abs(position.x - position.y) <= 1500) {
    return "mid_lane";
  }

  if (position.y > position.x + 2200) {
    return "top_side";
  }

  if (position.x > position.y + 2200) {
    return "bot_side";
  }

  return "jungle";
}

function eventActorId(event: TimelineEventDto): number | null {
  const participantId = event.participantId;
  if (typeof participantId === "number") {
    return participantId;
  }

  const creatorId = event.creatorId;
  if (typeof creatorId === "number") {
    return creatorId;
  }

  if (typeof event.killerId === "number") {
    return event.killerId;
  }

  return null;
}

function getDeathEventsForPlayer(timeline: MatchTimelineDto, participantId: number): TimelineEventDto[] {
  return timeline.info.frames.flatMap((frame) =>
    frame.events.filter((event) => event.type === "CHAMPION_KILL" && event.victimId === participantId),
  );
}

function buildPattern(
  params: Omit<StatPattern, "severity"> & { severity?: StatPattern["severity"] },
): StatPattern | null {
  if (params.totalGames <= 0) {
    return null;
  }

  const frequency = params.frequency;
  if (frequency <= 0.2) {
    return null;
  }

  return {
    ...params,
    severity: params.severity ?? severityFromFrequency(frequency),
  };
}

function objectivePosition(event: TimelineEventDto): { x: number; y: number } {
  if (event.position && typeof event.position.x === "number" && typeof event.position.y === "number") {
    return event.position;
  }

  if (event.monsterType === "BARON_NASHOR") {
    return BARON_PIT_POSITION;
  }

  return DRAGON_PIT_POSITION;
}

function enemyDamageProfile(match: MatchDto, playerTeamId: number): { highAp: boolean; highAd: boolean } {
  const enemies = match.info.participants.filter((participant) => participant.teamId !== playerTeamId);
  const magic = enemies.reduce((sum, participant) => sum + participant.magicDamageDealtToChampions, 0);
  const physical = enemies.reduce((sum, participant) => sum + participant.physicalDamageDealtToChampions, 0);
  const total = Math.max(1, magic + physical);

  return {
    highAp: magic / total >= 0.6,
    highAd: physical / total >= 0.6,
  };
}

function hasHealingHeavyEnemies(match: MatchDto, playerTeamId: number): boolean {
  const enemies = match.info.participants.filter((participant) => participant.teamId !== playerTeamId);
  return enemies.some((participant) => HEALING_HEAVY_CHAMPIONS.has(normalizeChampionName(participant.championName)));
}

function hasAnyItem(itemIds: number[], targetItems: Set<number>): boolean {
  return itemIds.some((itemId) => targetItems.has(itemId));
}

export function evaluateBuildCoverage(match: MatchDto, playerPuuid: string): BuildCoverage | null {
  const player = getPlayerParticipant(match, playerPuuid);
  if (!player) {
    return null;
  }

  const itemIds = getItemIds(player);
  const damageProfile = enemyDamageProfile(match, player.teamId);
  const requiresGrievous = hasHealingHeavyEnemies(match, player.teamId);
  const requiresMr = damageProfile.highAp;
  const requiresArmor = damageProfile.highAd;

  const builtGrievous =
    getAntiHealingCheck(itemIds, []) || hasAnyItem(itemIds, GRIEVOUS_WOUNDS_ITEM_IDS);
  const builtMr = hasAnyItem(itemIds, MAGIC_RESIST_ITEM_IDS);
  const builtArmor = hasAnyItem(itemIds, ARMOR_ITEM_IDS);

  const isAppropriate =
    (!requiresGrievous || builtGrievous) &&
    (!requiresMr || builtMr) &&
    (!requiresArmor || builtArmor);

  return {
    requiresGrievous,
    builtGrievous,
    requiresMr,
    builtMr,
    requiresArmor,
    builtArmor,
    isAppropriate,
  };
}

export function detectEarlyDeathPatterns(matches: MatchWithData[]): StatPattern[] {
  const totalGames = matches.length;
  if (totalGames === 0) {
    return [];
  }

  let gamesWithEarlyDeaths = 0;
  let gamesWithEarlyGanks = 0;
  let gamesWithEarlyTowerDives = 0;
  const earlyDeathMatchIds: string[] = [];
  const gankMatchIds: string[] = [];
  const towerDiveMatchIds: string[] = [];
  const deathPositionCounts = new Map<string, number>();

  for (const entry of matches) {
    const player = getPlayerParticipant(entry.match, entry.playerPuuid);
    if (!player) {
      continue;
    }

    const earlyDeaths = getDeathEventsForPlayer(entry.timeline, player.participantId).filter(
      (event) => event.timestamp < 10 * 60_000,
    );

    if (earlyDeaths.length === 0) {
      continue;
    }

    gamesWithEarlyDeaths += 1;
    earlyDeathMatchIds.push(entry.match.metadata.matchId);

    let hasGankDeath = false;
    let hasTowerDiveDeath = false;

    for (const death of earlyDeaths) {
      const positionKey = positionLabel(death.position);
      deathPositionCounts.set(positionKey, (deathPositionCounts.get(positionKey) ?? 0) + 1);

      const assistCount = death.assistingParticipantIds?.length ?? 0;
      if (assistCount >= 1) {
        hasGankDeath = true;
      }

      if (isNearTeamTurret(death.position, player.teamId)) {
        hasTowerDiveDeath = true;
      }
    }

    if (hasGankDeath) {
      gamesWithEarlyGanks += 1;
      gankMatchIds.push(entry.match.metadata.matchId);
    }

    if (hasTowerDiveDeath) {
      gamesWithEarlyTowerDives += 1;
      towerDiveMatchIds.push(entry.match.metadata.matchId);
    }
  }

  const hotZones = [...deathPositionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([zone]) => zone);

  const results: StatPattern[] = [];

  const basePattern = buildPattern({
    type: "early_death_before_10",
    frequency: gamesWithEarlyDeaths / totalGames,
    occurrences: gamesWithEarlyDeaths,
    totalGames,
    matchIds: earlyDeathMatchIds,
    details: {
      hotZones,
      gamesWithEarlyGanks,
      gamesWithEarlyTowerDives,
    },
    description: `Died before 10 minutes in ${gamesWithEarlyDeaths}/${totalGames} games.`,
  });
  if (basePattern) {
    results.push(basePattern);
  }

  const gankPattern = buildPattern({
    type: "early_death_to_gank",
    frequency: gamesWithEarlyGanks / totalGames,
    occurrences: gamesWithEarlyGanks,
    totalGames,
    matchIds: gankMatchIds,
    details: {
      threshold: "2+ enemies involved",
    },
    description: `Died to multi-person pressure before 10 minutes in ${gamesWithEarlyGanks}/${totalGames} games.`,
  });
  if (gankPattern) {
    results.push(gankPattern);
  }

  const towerDivePattern = buildPattern({
    type: "early_tower_dive_deaths",
    frequency: gamesWithEarlyTowerDives / totalGames,
    occurrences: gamesWithEarlyTowerDives,
    totalGames,
    matchIds: towerDiveMatchIds,
    details: {
      nearTurretRadius: 1600,
    },
    description: `Got tower dove early in ${gamesWithEarlyTowerDives}/${totalGames} games.`,
  });
  if (towerDivePattern) {
    results.push(towerDivePattern);
  }

  return results;
}

export function detectVisionPatterns(matches: MatchWithData[]): StatPattern[] {
  const totalGames = matches.length;
  if (totalGames === 0) {
    return [];
  }

  let lowVisionGames = 0;
  const lowVisionMatchIds: string[] = [];
  let totalVisionPerMinute = 0;
  let totalExpectedVisionPerMinute = 0;

  let objectiveGames = 0;
  let lowObjectivePrepGames = 0;
  const lowObjectivePrepMatchIds: string[] = [];

  for (const entry of matches) {
    const player = getPlayerParticipant(entry.match, entry.playerPuuid);
    if (!player) {
      continue;
    }

    const role = roleFromParticipant(player);
    const durationMinutes = getMatchDurationMinutes(entry.match);
    const visionPerMinute = player.visionScore / durationMinutes;
    const expected = expectedVisionPerMinute(role);

    totalVisionPerMinute += visionPerMinute;
    totalExpectedVisionPerMinute += expected;

    if (visionPerMinute < expected * 0.75) {
      lowVisionGames += 1;
      lowVisionMatchIds.push(entry.match.metadata.matchId);
    }

    const wardsPlacedEvents = entry.timeline.info.frames.flatMap((frame) =>
      frame.events.filter(
        (event) => event.type === "WARD_PLACED" && eventActorId(event) === player.participantId,
      ),
    );

    const objectiveEvents = entry.timeline.info.frames.flatMap((frame) =>
      frame.events.filter(
        (event) =>
          event.type === "ELITE_MONSTER_KILL" &&
          (event.monsterType === "DRAGON" ||
            event.monsterType === "ELDER_DRAGON" ||
            event.monsterType === "BARON_NASHOR"),
      ),
    );

    if (objectiveEvents.length > 0) {
      objectiveGames += 1;
      const preppedObjectives = objectiveEvents.filter((objective) =>
        wardsPlacedEvents.some(
          (ward) => ward.timestamp <= objective.timestamp && ward.timestamp >= objective.timestamp - 120_000,
        ),
      );

      if (preppedObjectives.length / objectiveEvents.length < 0.5) {
        lowObjectivePrepGames += 1;
        lowObjectivePrepMatchIds.push(entry.match.metadata.matchId);
      }
    }
  }

  const averageVisionPerMinute = totalVisionPerMinute / totalGames;
  const averageExpectedVisionPerMinute = totalExpectedVisionPerMinute / totalGames;
  const patterns: StatPattern[] = [];

  const lowVisionPattern = buildPattern({
    type: "consistently_low_vision",
    frequency: lowVisionGames / totalGames,
    occurrences: lowVisionGames,
    totalGames,
    matchIds: lowVisionMatchIds,
    details: {
      averageVisionPerMinute: Number(averageVisionPerMinute.toFixed(2)),
      expectedVisionPerMinute: Number(averageExpectedVisionPerMinute.toFixed(2)),
    },
    description: `Vision score per minute was below role expectations in ${lowVisionGames}/${totalGames} games.`,
  });
  if (lowVisionPattern) {
    patterns.push(lowVisionPattern);
  }

  if (objectiveGames > 0) {
    const objectivePattern = buildPattern({
      type: "poor_vision_pre_objective",
      frequency: lowObjectivePrepGames / objectiveGames,
      occurrences: lowObjectivePrepGames,
      totalGames: objectiveGames,
      matchIds: lowObjectivePrepMatchIds,
      details: {
        objectivePrepWindowMs: 120_000,
      },
      description: `Had weak ward setup before major objectives in ${lowObjectivePrepGames}/${objectiveGames} objective-heavy games.`,
    });
    if (objectivePattern) {
      patterns.push(objectivePattern);
    }
  }

  return patterns;
}

export function detectCSPatterns(matches: MatchWithData[]): StatPattern[] {
  const totalGames = matches.length;
  if (totalGames === 0) {
    return [];
  }

  let csDeficitGames = 0;
  const csDeficitMatchIds: string[] = [];
  let csDropoffGames = 0;
  const csDropoffMatchIds: string[] = [];
  let averageCsDiffAt10 = 0;

  for (const entry of matches) {
    const player = getPlayerParticipant(entry.match, entry.playerPuuid);
    if (!player) {
      continue;
    }

    const opponent = getLaneOpponent(entry.match, player);
    if (!opponent) {
      continue;
    }

    const playerCs10 = getCsAtMinute(entry.timeline, player.participantId, 10);
    const opponentCs10 = getCsAtMinute(entry.timeline, opponent.participantId, 10);
    const csDiffAt10 = playerCs10 - opponentCs10;
    averageCsDiffAt10 += csDiffAt10;

    if (csDiffAt10 <= -10) {
      csDeficitGames += 1;
      csDeficitMatchIds.push(entry.match.metadata.matchId);
    }

    const cs15 = getCsAtMinute(entry.timeline, player.participantId, 15);
    const totalCs = player.totalMinionsKilled + player.neutralMinionsKilled;
    const durationMinutes = getMatchDurationMinutes(entry.match);
    const lateMinutes = durationMinutes - 15;

    if (lateMinutes >= 5) {
      const earlyCsPerMin = cs15 / 15;
      const lateCs = Math.max(0, totalCs - cs15);
      const lateCsPerMin = lateCs / lateMinutes;

      if (lateCsPerMin < earlyCsPerMin * 0.75) {
        csDropoffGames += 1;
        csDropoffMatchIds.push(entry.match.metadata.matchId);
      }
    }
  }

  const patterns: StatPattern[] = [];
  const csDeficitPattern = buildPattern({
    type: "cs_deficit_at_10",
    frequency: csDeficitGames / totalGames,
    occurrences: csDeficitGames,
    totalGames,
    matchIds: csDeficitMatchIds,
    details: {
      averageCsDiffAt10: Number((averageCsDiffAt10 / totalGames).toFixed(1)),
      threshold: -10,
    },
    description: `Fell behind lane CS@10 in ${csDeficitGames}/${totalGames} games.`,
  });
  if (csDeficitPattern) {
    patterns.push(csDeficitPattern);
  }

  const csDropoffPattern = buildPattern({
    type: "mid_game_cs_dropoff",
    frequency: csDropoffGames / totalGames,
    occurrences: csDropoffGames,
    totalGames,
    matchIds: csDropoffMatchIds,
    details: {
      comparison: "0-15 min vs 15-end",
    },
    description: `CS/min dropped significantly after laning in ${csDropoffGames}/${totalGames} games.`,
  });
  if (csDropoffPattern) {
    patterns.push(csDropoffPattern);
  }

  return patterns;
}

export function detectBuildPatterns(matches: MatchWithData[]): StatPattern[] {
  const totalGames = matches.length;
  if (totalGames === 0) {
    return [];
  }

  let healingApplicableGames = 0;
  let missingGrievousGames = 0;
  const missingGrievousMatchIds: string[] = [];

  let apApplicableGames = 0;
  let missingMrGames = 0;
  const missingMrMatchIds: string[] = [];

  let adApplicableGames = 0;
  let missingArmorGames = 0;
  const missingArmorMatchIds: string[] = [];

  for (const entry of matches) {
    const coverage = evaluateBuildCoverage(entry.match, entry.playerPuuid);
    if (!coverage) {
      continue;
    }

    if (coverage.requiresGrievous) {
      healingApplicableGames += 1;
      if (!coverage.builtGrievous) {
        missingGrievousGames += 1;
        missingGrievousMatchIds.push(entry.match.metadata.matchId);
      }
    }

    if (coverage.requiresMr) {
      apApplicableGames += 1;
      if (!coverage.builtMr) {
        missingMrGames += 1;
        missingMrMatchIds.push(entry.match.metadata.matchId);
      }
    }

    if (coverage.requiresArmor) {
      adApplicableGames += 1;
      if (!coverage.builtArmor) {
        missingArmorGames += 1;
        missingArmorMatchIds.push(entry.match.metadata.matchId);
      }
    }
  }

  const patterns: StatPattern[] = [];

  if (healingApplicableGames > 0) {
    const grievousPattern = buildPattern({
      type: "missing_grievous_wounds",
      frequency: missingGrievousGames / healingApplicableGames,
      occurrences: missingGrievousGames,
      totalGames: healingApplicableGames,
      matchIds: missingGrievousMatchIds,
      details: {
        requiredItems: Array.from(GRIEVOUS_WOUNDS_ITEM_IDS),
      },
      description: `Skipped Grievous Wounds against healing-heavy comps in ${missingGrievousGames}/${healingApplicableGames} applicable games.`,
    });
    if (grievousPattern) {
      patterns.push(grievousPattern);
    }
  }

  if (apApplicableGames > 0) {
    const mrPattern = buildPattern({
      type: "missing_magic_resist",
      frequency: missingMrGames / apApplicableGames,
      occurrences: missingMrGames,
      totalGames: apApplicableGames,
      matchIds: missingMrMatchIds,
      details: {
        requiredItems: Array.from(MAGIC_RESIST_ITEM_IDS),
      },
      description: `Did not add Magic Resist versus high-AP teams in ${missingMrGames}/${apApplicableGames} applicable games.`,
    });
    if (mrPattern) {
      patterns.push(mrPattern);
    }
  }

  if (adApplicableGames > 0) {
    const armorPattern = buildPattern({
      type: "missing_armor",
      frequency: missingArmorGames / adApplicableGames,
      occurrences: missingArmorGames,
      totalGames: adApplicableGames,
      matchIds: missingArmorMatchIds,
      details: {
        requiredItems: Array.from(ARMOR_ITEM_IDS),
      },
      description: `Did not add armor versus high-AD teams in ${missingArmorGames}/${adApplicableGames} applicable games.`,
    });
    if (armorPattern) {
      patterns.push(armorPattern);
    }
  }

  return patterns;
}

export function detectObjectivePatterns(matches: MatchWithData[]): StatPattern[] {
  const totalGames = matches.length;
  if (totalGames === 0) {
    return [];
  }

  let gamesWithPreObjectiveDeaths = 0;
  const preObjectiveDeathMatchIds: string[] = [];
  let objectiveGames = 0;
  let objectiveMissGames = 0;
  const objectiveMissMatchIds: string[] = [];

  for (const entry of matches) {
    const player = getPlayerParticipant(entry.match, entry.playerPuuid);
    if (!player) {
      continue;
    }

    const deathEvents = getDeathEventsForPlayer(entry.timeline, player.participantId);
    const objectiveEvents = entry.timeline.info.frames.flatMap((frame) =>
      frame.events.filter(
        (event) =>
          event.type === "ELITE_MONSTER_KILL" &&
          (event.monsterType === "DRAGON" ||
            event.monsterType === "ELDER_DRAGON" ||
            event.monsterType === "BARON_NASHOR"),
      ),
    );

    if (objectiveEvents.length === 0) {
      continue;
    }

    objectiveGames += 1;

    const preObjectiveDeaths = objectiveEvents.filter((objective) =>
      deathEvents.some(
        (death) =>
          death.timestamp < objective.timestamp &&
          death.timestamp >= objective.timestamp - 90_000,
      ),
    );

    if (preObjectiveDeaths.length > 0) {
      gamesWithPreObjectiveDeaths += 1;
      preObjectiveDeathMatchIds.push(entry.match.metadata.matchId);
    }

    const missedObjectives = objectiveEvents.filter((objective) => {
      const involved =
        objective.killerId === player.participantId ||
        (objective.assistingParticipantIds?.includes(player.participantId) ?? false);

      if (involved) {
        return false;
      }

      const frame = getParticipantFrameAtOrBefore(entry.timeline, player.participantId, objective.timestamp);
      if (!frame?.position) {
        return true;
      }

      return distance(frame.position, objectivePosition(objective)) > 3500;
    });

    if (missedObjectives.length / objectiveEvents.length >= 0.5) {
      objectiveMissGames += 1;
      objectiveMissMatchIds.push(entry.match.metadata.matchId);
    }
  }

  const patterns: StatPattern[] = [];

  if (objectiveGames > 0) {
    const preObjectivePattern = buildPattern({
      type: "dies_before_objectives",
      frequency: gamesWithPreObjectiveDeaths / objectiveGames,
      occurrences: gamesWithPreObjectiveDeaths,
      totalGames: objectiveGames,
      matchIds: preObjectiveDeathMatchIds,
      details: {
        windowMs: 90_000,
      },
      description: `Died shortly before major objectives in ${gamesWithPreObjectiveDeaths}/${objectiveGames} objective games.`,
    });
    if (preObjectivePattern) {
      patterns.push(preObjectivePattern);
    }

    const objectivePresencePattern = buildPattern({
      type: "low_objective_presence",
      frequency: objectiveMissGames / objectiveGames,
      occurrences: objectiveMissGames,
      totalGames: objectiveGames,
      matchIds: objectiveMissMatchIds,
      details: {
        proximityRadius: 3500,
      },
      description: `Had low objective fight presence in ${objectiveMissGames}/${objectiveGames} objective games.`,
    });
    if (objectivePresencePattern) {
      patterns.push(objectivePresencePattern);
    }
  }

  return patterns;
}

function severityRank(severity: StatPattern["severity"]): number {
  if (severity === "high") {
    return 0;
  }
  if (severity === "medium") {
    return 1;
  }
  return 2;
}

export function runAllDetectors(matches: MatchWithData[]): StatPattern[] {
  const combined = [
    ...detectEarlyDeathPatterns(matches),
    ...detectVisionPatterns(matches),
    ...detectCSPatterns(matches),
    ...detectBuildPatterns(matches),
    ...detectObjectivePatterns(matches),
  ];

  const deduplicated = new Map<string, StatPattern>();

  for (const pattern of combined) {
    const existing = deduplicated.get(pattern.type);
    if (!existing) {
      deduplicated.set(pattern.type, pattern);
      continue;
    }

    const mergedMatchIds = Array.from(new Set([...existing.matchIds, ...pattern.matchIds]));
    const betterPattern =
      pattern.frequency > existing.frequency ||
      (pattern.frequency === existing.frequency &&
        severityRank(pattern.severity) < severityRank(existing.severity))
        ? pattern
        : existing;

    deduplicated.set(pattern.type, {
      ...betterPattern,
      matchIds: mergedMatchIds,
      occurrences: Math.max(existing.occurrences, pattern.occurrences),
    });
  }

  return [...deduplicated.values()].sort((a, b) => {
    const severityCompare = severityRank(a.severity) - severityRank(b.severity);
    if (severityCompare !== 0) {
      return severityCompare;
    }

    return b.frequency - a.frequency;
  });
}
