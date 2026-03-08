import type { MatchDto, MatchTimelineDto, TimelineEventDto } from "@/lib/types/riot";
import type { WinProbPoint } from "@/lib/win-probability";

export interface GameStateVector {
  features: number[];
  metadata: {
    matchId: string;
    minute: number;
    playerChampion: string;
    playerRole: string;
    rank: string;
    region: string;
    patch: string;
    isProGame: boolean;
    playerName?: string;
    teamName?: string;
  };
  outcome: {
    wonGame: boolean;
    next5MinEvents: string;
    goldDiffChange5Min: number;
    towersChange5Min: number;
    killsChange5Min: number;
    objectivesTaken: string[];
    winProbChange: number;
  };
}

const ROLE_TO_ENCODED: Record<string, number> = {
  TOP: 0,
  JUNGLE: 1,
  MID: 2,
  ADC: 3,
  SUPPORT: 4,
  UNKNOWN: 2,
};

const PLATFORM_TO_REGION: Record<string, string> = {
  NA1: "NA",
  BR1: "BR",
  LA1: "LATAM",
  LA2: "LATAM",
  OC1: "OCE",
  EUW1: "EUW",
  EUN1: "EUNE",
  TR1: "TR",
  RU: "RU",
  KR: "KR",
  JP1: "JP",
  PH2: "SEA",
  SG2: "SEA",
  TH2: "SEA",
  TW2: "SEA",
  VN2: "SEA",
};

const KEY_MINUTES = [5, 10, 15, 20, 25, 30];

function patchFromVersion(gameVersion: string): string {
  const [major, minor] = gameVersion.split(".");
  if (!major || !minor) {
    return gameVersion;
  }
  return `${major}.${minor}`;
}

function roleFromParticipant(participant: MatchDto["info"]["participants"][number]): string {
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
  if (participant.lane === "TOP") return "TOP";
  if (participant.lane === "JUNGLE") return "JUNGLE";
  if (participant.lane === "MIDDLE") return "MID";
  if (participant.lane === "BOTTOM" && participant.role === "DUO_SUPPORT") return "SUPPORT";
  if (participant.lane === "BOTTOM") return "ADC";
  return "UNKNOWN";
}

function participantTeamIdById(match: MatchDto, participantId: number): number | null {
  const participant = match.info.participants.find((entry) => entry.participantId === participantId);
  return participant?.teamId ?? null;
}

function getFrameAtOrBeforeMinute(
  timeline: MatchTimelineDto,
  minute: number,
): MatchTimelineDto["info"]["frames"][number] | null {
  const targetTimestamp = minute * 60_000;
  let candidate: MatchTimelineDto["info"]["frames"][number] | null = null;

  for (const frame of timeline.info.frames) {
    if (frame.timestamp <= targetTimestamp) {
      candidate = frame;
    } else {
      break;
    }
  }

  return candidate ?? timeline.info.frames[0] ?? null;
}

function teamAggregatesFromFrame(
  match: MatchDto,
  frame: MatchTimelineDto["info"]["frames"][number] | null,
  teamId: number,
): {
  gold: number;
  xp: number;
  cs: number;
  levels: number[];
} {
  if (!frame) {
    return { gold: 0, xp: 0, cs: 0, levels: [] };
  }

  let gold = 0;
  let xp = 0;
  let cs = 0;
  const levels: number[] = [];

  for (const participantFrame of Object.values(frame.participantFrames)) {
    const participantTeamId = participantTeamIdById(match, participantFrame.participantId);
    if (participantTeamId !== teamId) {
      continue;
    }

    gold += participantFrame.totalGold;
    xp += participantFrame.xp;
    cs += participantFrame.minionsKilled + participantFrame.jungleMinionsKilled;
    levels.push(participantFrame.level);
  }

  return { gold, xp, cs, levels };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function eventTeamId(match: MatchDto, event: TimelineEventDto): number | null {
  if (typeof event.killerId === "number" && event.killerId > 0) {
    return participantTeamIdById(match, event.killerId);
  }

  if (typeof event.teamId === "number") {
    return event.teamId;
  }

  return null;
}

function damageProfileValue(participants: MatchDto["info"]["participants"]): number {
  if (participants.length === 0) {
    return 0.5;
  }

  const apDealers = participants.filter(
    (participant) =>
      participant.magicDamageDealtToChampions >= participant.physicalDamageDealtToChampions,
  ).length;

  const ratio = apDealers / participants.length;
  if (ratio >= 0.65) {
    return 1;
  }
  if (ratio <= 0.35) {
    return 0;
  }
  return 0.5;
}

function normalizedGoldDiff(goldDiff: number, minute: number): number {
  const avgTotalGoldAtMinute = Math.max(2000, minute * 1500);
  return goldDiff / avgTotalGoldAtMinute;
}

function countObjectivesUntil(
  match: MatchDto,
  timeline: MatchTimelineDto,
  minute: number,
  teamId: number,
): {
  kills: number;
  towers: number;
  dragons: number;
  enemyDragons: number;
  inhibsDown: number;
  baronActive: boolean;
  elderActive: boolean;
} {
  const timestamp = minute * 60_000;
  const enemyTeamId = teamId === 100 ? 200 : 100;
  let kills = 0;
  let towers = 0;
  let dragons = 0;
  let enemyDragons = 0;
  let inhibsDown = 0;
  let lastBaronAt = 0;
  let lastElderAt = 0;

  for (const frame of timeline.info.frames) {
    for (const event of frame.events) {
      if (event.timestamp > timestamp) {
        continue;
      }

      if (event.type === "CHAMPION_KILL") {
        const team = eventTeamId(match, event);
        if (team === teamId) {
          kills += 1;
        }
        continue;
      }

      if (event.type === "BUILDING_KILL") {
        const team = eventTeamId(match, event);
        if (team !== teamId) {
          continue;
        }

        if (event.buildingType === "TOWER_BUILDING") {
          towers += 1;
        }
        if (event.buildingType === "INHIBITOR_BUILDING") {
          inhibsDown += 1;
        }
        continue;
      }

      if (event.type !== "ELITE_MONSTER_KILL") {
        continue;
      }

      const team = eventTeamId(match, event);
      if (team === null) {
        continue;
      }

      if (event.monsterType === "DRAGON") {
        if (team === teamId) {
          dragons += 1;
        } else if (team === enemyTeamId) {
          enemyDragons += 1;
        }
      }

      if (event.monsterType === "BARON_NASHOR" && team === teamId) {
        lastBaronAt = event.timestamp;
      }

      if (
        (event.monsterType === "ELDER_DRAGON" || event.monsterSubType === "ELDER_DRAGON") &&
        team === teamId
      ) {
        lastElderAt = event.timestamp;
      }
    }
  }

  return {
    kills,
    towers,
    dragons,
    enemyDragons,
    inhibsDown,
    baronActive: lastBaronAt > 0 && lastBaronAt + 180_000 > timestamp,
    elderActive: lastElderAt > 0 && lastElderAt + 150_000 > timestamp,
  };
}

function minMaxNormalize(value: number, min: number, max: number): number {
  if (max <= min) {
    return 0;
  }

  const normalized = (value - min) / (max - min);
  return Math.max(0, Math.min(1, normalized));
}

function nearestWinProb(
  timeline: WinProbPoint[] | undefined,
  minute: number,
): number | null {
  if (!timeline || timeline.length === 0) {
    return null;
  }

  const timestamp = minute * 60_000;
  let candidate: WinProbPoint | null = null;

  for (const point of timeline) {
    if (point.timestamp <= timestamp) {
      candidate = point;
    } else {
      break;
    }
  }

  return candidate?.winProbability ?? timeline[0]?.winProbability ?? null;
}

export class GameStateEncoder {
  encodeGameState(
    match: MatchDto,
    timeline: MatchTimelineDto,
    playerPuuid: string,
    minute: number,
    winProbTimeline?: WinProbPoint[],
  ): GameStateVector {
    const player = match.info.participants.find((participant) => participant.puuid === playerPuuid);
    if (!player) {
      throw new Error("Cannot encode game state: player not found in match.");
    }

    const maxMinute = Math.max(1, Math.floor(match.info.gameDuration / 60));
    const safeMinute = Math.max(1, Math.min(minute, maxMinute));
    const playerTeamId = player.teamId;
    const enemyTeamId = playerTeamId === 100 ? 200 : 100;
    const frame = getFrameAtOrBeforeMinute(timeline, safeMinute);

    const team = teamAggregatesFromFrame(match, frame, playerTeamId);
    const enemy = teamAggregatesFromFrame(match, frame, enemyTeamId);

    const objectives = countObjectivesUntil(match, timeline, safeMinute, playerTeamId);
    const enemyObjectives = countObjectivesUntil(match, timeline, safeMinute, enemyTeamId);

    const killDiff = objectives.kills - enemyObjectives.kills;
    const towerDiff = objectives.towers - enemyObjectives.towers;
    const goldDiff = team.gold - enemy.gold;
    const csDiff = team.cs - enemy.cs;

    const playerFrame = frame?.participantFrames[String(player.participantId)];
    const playerCs = playerFrame
      ? playerFrame.minionsKilled + playerFrame.jungleMinionsKilled
      : player.totalMinionsKilled + player.neutralMinionsKilled;

    const playerKdaRatio =
      (player.kills + player.assists) / Math.max(1, player.deaths);
    const playerGoldShare = team.gold > 0 ? (playerFrame?.totalGold ?? player.goldEarned) / team.gold : 0;
    const playerCsPerMin = playerCs / Math.max(1, safeMinute);
    const levelDiffAvg = average(team.levels) - average(enemy.levels);

    const allyParticipants = match.info.participants.filter(
      (participant) => participant.teamId === playerTeamId,
    );
    const enemyParticipants = match.info.participants.filter(
      (participant) => participant.teamId === enemyTeamId,
    );

    const features = [
      safeMinute,
      goldDiff,
      normalizedGoldDiff(goldDiff, safeMinute),
      killDiff,
      towerDiff,
      objectives.dragons,
      objectives.enemyDragons,
      objectives.dragons >= 4 ? 1 : 0,
      objectives.baronActive ? 1 : 0,
      objectives.elderActive ? 1 : 0,
      objectives.inhibsDown,
      csDiff / Math.max(1, safeMinute),
      levelDiffAvg,
      player.championId,
      ROLE_TO_ENCODED[roleFromParticipant(player)] ?? ROLE_TO_ENCODED.UNKNOWN,
      playerKdaRatio,
      playerGoldShare,
      playerCsPerMin,
      damageProfileValue(allyParticipants),
      damageProfileValue(enemyParticipants),
    ];

    const outcome = this.computeOutcome(match, timeline, playerPuuid, safeMinute);

    const startProb = nearestWinProb(winProbTimeline, safeMinute);
    const endProb = nearestWinProb(winProbTimeline, Math.min(maxMinute, safeMinute + 5));
    if (startProb !== null && endProb !== null) {
      outcome.winProbChange = Number((endProb - startProb).toFixed(4));
    }

    return {
      features,
      metadata: {
        matchId: match.metadata.matchId,
        minute: safeMinute,
        playerChampion: player.championName,
        playerRole: roleFromParticipant(player),
        rank: "Unknown",
        region: PLATFORM_TO_REGION[match.info.platformId?.toUpperCase()] ?? "Unknown",
        patch: patchFromVersion(match.info.gameVersion),
        isProGame: false,
      },
      outcome,
    };
  }

  encodeAllKeyMoments(
    match: MatchDto,
    timeline: MatchTimelineDto,
    playerPuuid: string,
    winProbTimeline?: WinProbPoint[],
  ): GameStateVector[] {
    const maxMinute = Math.max(1, Math.floor(match.info.gameDuration / 60));
    const minutes = KEY_MINUTES.filter((minute) => minute <= maxMinute);

    if (minutes.length === 0) {
      minutes.push(Math.max(1, Math.min(5, maxMinute)));
    }

    return minutes.map((minute) =>
      this.encodeGameState(match, timeline, playerPuuid, minute, winProbTimeline),
    );
  }

  normalizeVector(features: number[]): number[] {
    const ranges: Array<[number, number]> = [
      [0, 45],
      [-15000, 15000],
      [-1, 1],
      [-20, 20],
      [-11, 11],
      [0, 6],
      [0, 6],
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 3],
      [-50, 50],
      [-3, 3],
      [1, 1000],
      [0, 4],
      [0, 20],
      [0, 1],
      [0, 15],
      [0, 1],
      [0, 1],
    ];

    return features.map((feature, index) => {
      const [min, max] = ranges[index] ?? [0, 1];
      return minMaxNormalize(feature, min, max);
    });
  }

  computeOutcome(
    match: MatchDto,
    timeline: MatchTimelineDto,
    playerPuuid: string,
    minute: number,
  ): GameStateVector["outcome"] {
    const player = match.info.participants.find((participant) => participant.puuid === playerPuuid);
    if (!player) {
      throw new Error("Cannot compute game state outcome: player not found in match.");
    }

    const playerTeamId = player.teamId;
    const enemyTeamId = playerTeamId === 100 ? 200 : 100;
    const maxMinute = Math.max(1, Math.floor(match.info.gameDuration / 60));
    const startMinute = Math.max(1, Math.min(minute, maxMinute));
    const endMinute = Math.max(startMinute, Math.min(maxMinute, startMinute + 5));

    const startFrame = getFrameAtOrBeforeMinute(timeline, startMinute);
    const endFrame = getFrameAtOrBeforeMinute(timeline, endMinute);

    const startTeam = teamAggregatesFromFrame(match, startFrame, playerTeamId);
    const startEnemy = teamAggregatesFromFrame(match, startFrame, enemyTeamId);
    const endTeam = teamAggregatesFromFrame(match, endFrame, playerTeamId);
    const endEnemy = teamAggregatesFromFrame(match, endFrame, enemyTeamId);

    const startGoldDiff = startTeam.gold - startEnemy.gold;
    const endGoldDiff = endTeam.gold - endEnemy.gold;
    const goldDiffChange5Min = endGoldDiff - startGoldDiff;

    const startTimestamp = startMinute * 60_000;
    const endTimestamp = endMinute * 60_000;

    let killsFor = 0;
    let killsAgainst = 0;
    let towersFor = 0;
    let towersAgainst = 0;
    const objectivesTaken = new Set<string>();

    for (const frame of timeline.info.frames) {
      for (const event of frame.events) {
        if (event.timestamp < startTimestamp || event.timestamp > endTimestamp) {
          continue;
        }

        const team = eventTeamId(match, event);

        if (event.type === "CHAMPION_KILL") {
          if (team === playerTeamId) {
            killsFor += 1;
          } else if (team === enemyTeamId) {
            killsAgainst += 1;
          }
        }

        if (event.type === "BUILDING_KILL" && event.buildingType === "TOWER_BUILDING") {
          if (team === playerTeamId) {
            towersFor += 1;
            objectivesTaken.add("tower");
          } else if (team === enemyTeamId) {
            towersAgainst += 1;
          }
        }

        if (event.type === "ELITE_MONSTER_KILL") {
          if (team !== playerTeamId) {
            continue;
          }

          if (event.monsterType === "DRAGON") {
            objectivesTaken.add("dragon");
          }
          if (event.monsterType === "BARON_NASHOR") {
            objectivesTaken.add("baron");
          }
          if (event.monsterType === "RIFTHERALD") {
            objectivesTaken.add("herald");
          }
        }
      }
    }

    const killsChange5Min = killsFor - killsAgainst;
    const towersChange5Min = towersFor - towersAgainst;

    const objectiveText = objectivesTaken.size > 0
      ? `Objectives: ${Array.from(objectivesTaken).join(", ")}`
      : "No major objectives secured";

    const next5MinEvents = [
      `Kills: ${killsFor}-${killsAgainst}`,
      `Towers: ${towersFor}-${towersAgainst}`,
      objectiveText,
    ].join(" | ");

    const heuristicWinProbDelta = Math.max(
      -1,
      Math.min(
        1,
        goldDiffChange5Min / 8000 + killsChange5Min * 0.02 + towersChange5Min * 0.06 + objectivesTaken.size * 0.04,
      ),
    );

    return {
      wonGame: player.win,
      next5MinEvents,
      goldDiffChange5Min,
      towersChange5Min,
      killsChange5Min,
      objectivesTaken: Array.from(objectivesTaken),
      winProbChange: Number(heuristicWinProbDelta.toFixed(4)),
    };
  }
}

export const gameStateEncoder = new GameStateEncoder();
