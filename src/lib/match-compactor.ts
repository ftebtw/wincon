import type { DualCompAnalysis } from "@/lib/comp-classifier";
import type {
  AnalyzedEvent,
  GoldEfficiencyEvent,
  RecallEvent,
  Teamfight,
} from "@/lib/play-by-play";
import type { RankBenchmarks } from "@/lib/rank-benchmarks";
import type { PlayerWPASummary } from "@/lib/wpa-engine";
import type {
  MatchDto,
  MatchTimelineDto,
  ParticipantDto,
  TimelineEventDto,
} from "@/lib/types/riot";
import type { KeyMoment, WinProbPoint } from "@/lib/win-probability";

export interface CompactedMatchData {
  playerInfo: {
    gameName: string;
    tagLine: string;
    champion: string;
    role: string;
    rank: string;
    result: "WIN" | "LOSS";
    gameDuration: string;
    kda: string;
    cs: number;
    csPerMin: number;
    visionScore: number;
  };
  teamComps: {
    allies: string;
    enemies: string;
    allyCompTags: string;
    enemyCompTags: string;
  };
  keyMoments: {
    timestamp: string;
    description: string;
    winProbChange: string;
    context: string;
  }[];
  gameState: {
    minuteByMinute: string;
  };
  builds: {
    playerBuild: string;
    opponentBuild: string;
  };
  objectives: string;
  teamfights: string[];
  goldEfficiencyIssues: string[];
  recallTiming: string[];
  rankBenchmarks: string[];
  abilityContext: string[];
  aiRelevantEvents: string[];
  wpaSummary: string[];
  similarGameReferences: string[];
  contextualBuildSummary: string[];
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function roleFromParticipant(participant: ParticipantDto): string {
  const byPosition: Record<string, string> = {
    TOP: "TOP",
    JUNGLE: "JG",
    MIDDLE: "MID",
    BOTTOM: "ADC",
    UTILITY: "SUP",
  };

  if (participant.teamPosition && participant.teamPosition in byPosition) {
    return byPosition[participant.teamPosition];
  }

  if (participant.lane === "JUNGLE") {
    return "JG";
  }

  if (participant.lane === "MIDDLE") {
    return "MID";
  }

  if (participant.lane === "TOP") {
    return "TOP";
  }

  if (participant.lane === "BOTTOM" && participant.role === "DUO_SUPPORT") {
    return "SUP";
  }

  if (participant.lane === "BOTTOM") {
    return "ADC";
  }

  return "UNK";
}

function participantCs(participant: ParticipantDto): number {
  return participant.totalMinionsKilled + participant.neutralMinionsKilled;
}

function signed(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function formatWinProbChange(before: number, after: number): string {
  const beforePct = Math.round(before * 100);
  const afterPct = Math.round(after * 100);
  const delta = afterPct - beforePct;

  return `${beforePct}% -> ${afterPct}% (${signed(delta)}%)`;
}

function findLaneOpponent(
  player: ParticipantDto,
  enemies: ParticipantDto[],
): ParticipantDto | undefined {
  if (player.teamPosition) {
    const byTeamPosition = enemies.find(
      (candidate) => candidate.teamPosition === player.teamPosition,
    );
    if (byTeamPosition) {
      return byTeamPosition;
    }
  }

  const playerRole = roleFromParticipant(player);
  const byRole = enemies.find((candidate) => roleFromParticipant(candidate) === playerRole);

  return byRole ?? enemies[0];
}

function formatTeamComp(participants: ParticipantDto[]): string {
  return participants
    .map((participant) => `${participant.championName} ${roleFromParticipant(participant)}`)
    .join(", ");
}

function buildMinuteByMinuteSummary(
  timeline: MatchTimelineDto,
  playerTeamId: number,
): string {
  const relevantFrames = timeline.info.frames.filter((frame, index, allFrames) => {
    const minute = Math.floor(frame.timestamp / 60_000);
    return minute % 5 === 0 || index === 0 || index === allFrames.length - 1;
  });

  if (relevantFrames.length === 0) {
    return "No timeline frames available.";
  }

  const chunks = relevantFrames.map((frame) => {
    let teamGold = 0;
    let enemyGold = 0;
    let teamXp = 0;
    let enemyXp = 0;
    let teamCs = 0;
    let enemyCs = 0;

    for (const participantFrame of Object.values(frame.participantFrames)) {
      const participantTeamId = participantFrame.participantId <= 5 ? 100 : 200;
      const participantCsValue =
        participantFrame.minionsKilled + participantFrame.jungleMinionsKilled;

      if (participantTeamId === playerTeamId) {
        teamGold += participantFrame.totalGold;
        teamXp += participantFrame.xp;
        teamCs += participantCsValue;
      } else {
        enemyGold += participantFrame.totalGold;
        enemyXp += participantFrame.xp;
        enemyCs += participantCsValue;
      }
    }

    const minute = Math.floor(frame.timestamp / 60_000);
    return `Min ${minute}: ${signed(teamGold - enemyGold)}g, ${signed(teamCs - enemyCs)}cs, ${signed(teamXp - enemyXp)}xp`;
  });

  return chunks.join(" | ");
}

function extractBuildPath(
  timeline: MatchTimelineDto,
  participantId: number,
): string {
  const purchases: Array<{ timestamp: number; itemId: number }> = [];

  for (const frame of timeline.info.frames) {
    for (const event of frame.events) {
      if (
        event.type === "ITEM_PURCHASED" &&
        event.participantId === participantId &&
        typeof event.itemId === "number"
      ) {
        purchases.push({ timestamp: event.timestamp, itemId: event.itemId });
      }
    }
  }

  if (purchases.length === 0) {
    return "No purchase data";
  }

  purchases.sort((a, b) => a.timestamp - b.timestamp);
  return purchases
    .slice(0, 12)
    .map((purchase) => `Item ${purchase.itemId} (${formatTimestamp(purchase.timestamp)})`)
    .join(" -> ");
}

function teamIdByParticipantId(match: MatchDto, participantId: number): number | undefined {
  return match.info.participants.find((participant) => participant.participantId === participantId)
    ?.teamId;
}

function summarizeObjectives(
  match: MatchDto,
  timeline: MatchTimelineDto,
  playerTeamId: number,
): string {
  const enemyTeamId = playerTeamId === 100 ? 200 : 100;
  const playerTeam = match.info.teams.find((team) => team.teamId === playerTeamId);
  const enemyTeam = match.info.teams.find((team) => team.teamId === enemyTeamId);

  const dragonTimes: string[] = [];
  const baronTimes: string[] = [];

  for (const frame of timeline.info.frames) {
    for (const event of frame.events) {
      if (event.type !== "ELITE_MONSTER_KILL") {
        continue;
      }

      const killerTeamId =
        teamIdByParticipantId(match, event.killerId ?? -1) ??
        (typeof event.teamId === "number" ? event.teamId : undefined);

      if (killerTeamId !== playerTeamId) {
        continue;
      }

      if (event.monsterType === "DRAGON") {
        const dragonType = event.monsterSubType?.replace(/_/g, " ") ?? "Dragon";
        dragonTimes.push(`${dragonType} ${formatTimestamp(event.timestamp)}`);
      } else if (event.monsterType === "BARON_NASHOR") {
        baronTimes.push(formatTimestamp(event.timestamp));
      }
    }
  }

  const dragonCount = playerTeam?.objectives.dragon.kills ?? 0;
  const baronCount = playerTeam?.objectives.baron.kills ?? 0;
  const teamTowers = playerTeam?.objectives.tower.kills ?? 0;
  const enemyTowers = enemyTeam?.objectives.tower.kills ?? 0;

  const dragonDetail =
    dragonTimes.length > 0 ? dragonTimes.slice(0, 3).join(", ") : "none";
  const baronDetail =
    baronTimes.length > 0 ? baronTimes.slice(0, 2).join(", ") : "none";

  return `Dragons: ${dragonCount} (${dragonDetail}) | Baron: ${baronCount} (${baronDetail}) | Towers: ${teamTowers}-${enemyTowers}`;
}

function signedPercent(value: number): string {
  const pct = Math.round(value * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function formatTeamfightSummaries(
  teamfights: Teamfight[] | undefined,
  playerTeamId: number,
): string[] {
  if (!teamfights || teamfights.length === 0) {
    return ["No major clustered fights were detected."];
  }

  const expectedWinner = playerTeamId === 100 ? "blue" : "red";
  return teamfights.slice(0, 4).map((fight, index) => {
    const fightTime = formatTimestamp(fight.startTime);
    const relativeOutcome =
      fight.winner === "trade"
        ? "was a trade"
        : fight.winner === expectedWinner
          ? "your team won"
          : "your team lost";
    const objective = fight.objectiveAfter
      ? ` Took ${fight.objectiveAfter} after.`
      : "";
    const playerLine = `You: ${fight.playerPerformance.kills}/${fight.playerPerformance.deaths}/${fight.playerPerformance.assists}, ${fight.playerPerformance.survived ? "survived" : "died"}, positioning ${fight.playerPerformance.positioning}.`;
    return `Fight ${index + 1} (${fightTime}): ${relativeOutcome} (${fight.blueKills}-${fight.redKills} kills), WPA ${signedPercent(fight.wpaDelta)}. ${playerLine}${objective}`;
  });
}

function formatGoldEfficiencyIssues(events: GoldEfficiencyEvent[] | undefined): string[] {
  if (!events || events.length === 0) {
    return ["No major gold inefficiency windows detected."];
  }

  return events.slice(0, 3).map((event) => {
    const at = formatTimestamp(event.timestamp);
    return `${at}: sat on ${Math.round(event.currentGold)}g for ${event.minutesSinceLastPurchase}m.`;
  });
}

function formatRecallTiming(recalls: RecallEvent[] | undefined): string[] {
  if (!recalls || recalls.length === 0) {
    return ["No clear recall windows detected from timeline data."];
  }

  const flagged = recalls.filter((recall) => !recall.wasEfficient || recall.missedObjective);
  const source = flagged.length > 0 ? flagged : recalls;
  return source.slice(0, 3).map((recall) => {
    const at = formatTimestamp(recall.timestamp);
    return `${at}: ${recall.wasEfficient ? "efficient" : "inefficient"} recall (${recall.goldBeforeRecall}g), est CS lost ${recall.csLostEstimate}${recall.missedObjective ? ", objective spawned during reset" : ""}.`;
  });
}

function benchmarkLine(label: string, metric: RankBenchmarks[keyof RankBenchmarks]): string {
  return `${label}: ${Number(metric.player.toFixed(2))} (rank avg ${Number(metric.rankAvg.toFixed(2))}, ${metric.percentile}th percentile)`;
}

function formatRankBenchmarks(benchmarks: RankBenchmarks | undefined): string[] {
  if (!benchmarks) {
    return ["Rank benchmark data unavailable for this champion/role."];
  }

  return [
    benchmarkLine("CS@10", benchmarks.csAt10),
    benchmarkLine("Gold@10", benchmarks.goldAt10),
    benchmarkLine("Vision Score", benchmarks.visionScore),
    benchmarkLine("Deaths before 10", benchmarks.deathsBefore10),
    benchmarkLine("Damage Share", benchmarks.damageShare),
    benchmarkLine("KDA", benchmarks.kda),
    benchmarkLine("CS/min", benchmarks.csPerMin),
  ];
}

function formatAiRelevantEvents(events: AnalyzedEvent[] | undefined): string[] {
  if (!events || events.length === 0) {
    return ["No additional AI-relevant micro events selected."];
  }

  return events.slice(0, 8).map((event) => {
    const delta = signedPercent(event.wpaDelta);
    const objectiveHint =
      event.context.objectivesUp.length > 0
        ? ` | next objectives: ${event.context.objectivesUp.join(", ")}`
        : "";
    return `${formatTimestamp(event.timestamp)} ${event.type}: ${event.description} (${delta})${objectiveHint}`;
  });
}

function formatWpa(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function formatWpaSummary(params: {
  playerSummary?: PlayerWPASummary;
  allPlayers?: PlayerWPASummary[];
}): string[] {
  const { playerSummary, allPlayers } = params;
  if (!playerSummary || !allPlayers || allPlayers.length === 0) {
    return ["WPA summary unavailable for this match."];
  }

  const sorted = [...allPlayers].sort((a, b) => b.totalWPA - a.totalWPA);
  const mvp = sorted[0];
  const worst = sorted[sorted.length - 1];
  const bestPlayDelta = playerSummary.biggestPositivePlay.attributions
    .filter((entry) => entry.puuid === playerSummary.puuid)
    .reduce((sum, entry) => sum + entry.wpaValue, 0);
  const worstPlayDelta = playerSummary.biggestNegativePlay.attributions
    .filter((entry) => entry.puuid === playerSummary.puuid)
    .reduce((sum, entry) => sum + entry.wpaValue, 0);

  return [
    `Your total WPA: ${formatWpa(playerSummary.totalWPA)} (${playerSummary.rank} of ${sorted.length} players)`,
    `Positive contributions: ${formatWpa(playerSummary.positiveWPA)} | Negative contributions: ${formatWpa(playerSummary.negativeWPA)}`,
    `Best play: ${playerSummary.biggestPositivePlay.type} at ${formatTimestamp(playerSummary.biggestPositivePlay.timestamp)} (${formatWpa(bestPlayDelta)})`,
    `Worst play: ${playerSummary.biggestNegativePlay.type} at ${formatTimestamp(playerSummary.biggestNegativePlay.timestamp)} (${formatWpa(worstPlayDelta)})`,
    `MVP: ${mvp.champion} ${mvp.role} (${formatWpa(mvp.totalWPA)})`,
    `Lowest impact: ${worst.champion} ${worst.role} (${formatWpa(worst.totalWPA)})`,
  ];
}

function getContextForKeyMoment(
  keyMoment: KeyMoment,
  winProbTimeline: WinProbPoint[],
): string {
  const point = winProbTimeline.find((candidate) => candidate.minute === keyMoment.minute);

  if (!point) {
    return "Context unavailable";
  }

  return `Gold diff: ${signed(point.gameState.goldDiff)}, Towers diff: ${signed(point.gameState.towerDiff)}, Dragons diff: ${signed(point.gameState.dragonDiff)}`;
}

function formatKeyMoments(
  keyMoments: KeyMoment[],
  winProbTimeline: WinProbPoint[],
): CompactedMatchData["keyMoments"] {
  return keyMoments.map((keyMoment) => {
    const firstEvent = keyMoment.events[0];
    const lastEvent = keyMoment.events[keyMoment.events.length - 1];
    const before = firstEvent?.winProbBefore ?? 0.5;
    const after = lastEvent?.winProbAfter ?? before + keyMoment.totalDelta;

    return {
      timestamp: formatTimestamp(keyMoment.timestamp),
      description: keyMoment.description,
      winProbChange: formatWinProbChange(before, after),
      context: getContextForKeyMoment(keyMoment, winProbTimeline),
    };
  });
}

function getChampionNameByParticipantId(
  match: MatchDto,
  participantId: number,
): string {
  return (
    match.info.participants.find((participant) => participant.participantId === participantId)
      ?.championName ?? "Unknown"
  );
}

function enrichEventsWithChampionNames(match: MatchDto, events: TimelineEventDto[]): string[] {
  return events.map((event) => {
    if (event.type === "CHAMPION_KILL") {
      const killer = getChampionNameByParticipantId(match, event.killerId ?? -1);
      const victim = getChampionNameByParticipantId(match, event.victimId ?? -1);
      return `${formatTimestamp(event.timestamp)} ${killer} killed ${victim}`;
    }

    if (event.type === "ELITE_MONSTER_KILL") {
      const monster = event.monsterSubType ?? event.monsterType ?? "objective";
      return `${formatTimestamp(event.timestamp)} ${monster.replace(/_/g, " ")}`;
    }

    return `${formatTimestamp(event.timestamp)} ${event.type}`;
  });
}

export function compactMatchForLLM(
  match: MatchDto,
  timeline: MatchTimelineDto,
  playerPuuid: string,
  winProbTimeline: WinProbPoint[],
  keyMoments: KeyMoment[],
  compAnalysis: DualCompAnalysis,
  playerRank = "Unknown",
  deepContext?: {
    teamfights?: Teamfight[];
    recalls?: RecallEvent[];
    goldEfficiency?: GoldEfficiencyEvent[];
    aiRelevantEvents?: AnalyzedEvent[];
    rankBenchmarks?: RankBenchmarks;
    abilityContext?: string[];
    wpa?: {
      playerSummary?: PlayerWPASummary;
      allPlayers?: PlayerWPASummary[];
    };
    similarGameReferences?: string[];
    contextualBuildSummary?: string[];
  },
): CompactedMatchData {
  const playerParticipant = match.info.participants.find(
    (participant) => participant.puuid === playerPuuid,
  );

  if (!playerParticipant) {
    throw new Error("Unable to compact match: player not found in match data.");
  }

  const playerTeamId = playerParticipant.teamId;
  const allies = match.info.participants.filter(
    (participant) => participant.teamId === playerTeamId,
  );
  const enemies = match.info.participants.filter(
    (participant) => participant.teamId !== playerTeamId,
  );
  const laneOpponent = findLaneOpponent(playerParticipant, enemies);

  const playerCs = participantCs(playerParticipant);
  const gameDurationMinutes = Math.max(match.info.gameDuration / 60, 1);

  const playerInfo: CompactedMatchData["playerInfo"] = {
    gameName: playerParticipant.riotIdGameName ?? playerParticipant.summonerName,
    tagLine: playerParticipant.riotIdTagline ?? "NA1",
    champion: playerParticipant.championName,
    role: roleFromParticipant(playerParticipant),
    rank: playerRank,
    result: playerParticipant.win ? "WIN" : "LOSS",
    gameDuration: formatDuration(match.info.gameDuration),
    kda: `${playerParticipant.kills}/${playerParticipant.deaths}/${playerParticipant.assists}`,
    cs: playerCs,
    csPerMin: Number((playerCs / gameDurationMinutes).toFixed(1)),
    visionScore: playerParticipant.visionScore,
  };

  const playerBuild = extractBuildPath(timeline, playerParticipant.participantId);
  const opponentBuild = laneOpponent
    ? extractBuildPath(timeline, laneOpponent.participantId)
    : "No lane opponent found";

  const playerEvents = timeline.info.frames.flatMap((frame) =>
    frame.events.filter(
      (event) =>
        (event.killerId ?? -1) === playerParticipant.participantId ||
        (event.victimId ?? -1) === playerParticipant.participantId,
    ),
  );

  const extraMomentDescriptions = enrichEventsWithChampionNames(match, playerEvents).slice(0, 5);
  const compactedKeyMoments = formatKeyMoments(
    keyMoments,
    winProbTimeline,
  ).map((keyMoment, index) => {
    const fallback = extraMomentDescriptions[index];
    if (!fallback) {
      return keyMoment;
    }

    return {
      ...keyMoment,
      description: keyMoment.description || fallback,
    };
  });

  return {
    playerInfo,
    teamComps: {
      allies: formatTeamComp(allies),
      enemies: formatTeamComp(enemies),
      allyCompTags: compAnalysis.ally.tags.join(", "),
      enemyCompTags: compAnalysis.enemy.tags.join(", "),
    },
    keyMoments: compactedKeyMoments,
    gameState: {
      minuteByMinute: buildMinuteByMinuteSummary(timeline, playerTeamId),
    },
    builds: {
      playerBuild,
      opponentBuild,
    },
    objectives: summarizeObjectives(match, timeline, playerTeamId),
    teamfights: formatTeamfightSummaries(deepContext?.teamfights, playerTeamId),
    goldEfficiencyIssues: formatGoldEfficiencyIssues(deepContext?.goldEfficiency),
    recallTiming: formatRecallTiming(deepContext?.recalls),
    rankBenchmarks: formatRankBenchmarks(deepContext?.rankBenchmarks),
    abilityContext:
      deepContext?.abilityContext && deepContext.abilityContext.length > 0
        ? deepContext.abilityContext
        : ["Ability cooldown context unavailable for key deaths."],
    aiRelevantEvents: formatAiRelevantEvents(deepContext?.aiRelevantEvents),
    wpaSummary: formatWpaSummary({
      playerSummary: deepContext?.wpa?.playerSummary,
      allPlayers: deepContext?.wpa?.allPlayers,
    }),
    similarGameReferences:
      deepContext?.similarGameReferences && deepContext.similarGameReferences.length > 0
        ? deepContext.similarGameReferences.slice(0, 4)
        : ["No close historical comparison available for this game state."],
    contextualBuildSummary:
      deepContext?.contextualBuildSummary &&
      deepContext.contextualBuildSummary.length > 0
        ? deepContext.contextualBuildSummary.slice(0, 10)
        : ["Contextual build recommendation unavailable for this match."],
  };
}

export function formatForPrompt(compacted: CompactedMatchData): string {
  const sections = [
    "=== PLAYER INFO ===",
    `Player: ${compacted.playerInfo.gameName}#${compacted.playerInfo.tagLine}`,
    `Champion/Role: ${compacted.playerInfo.champion} ${compacted.playerInfo.role}`,
    `Rank: ${compacted.playerInfo.rank}`,
    `Result: ${compacted.playerInfo.result}`,
    `Duration: ${compacted.playerInfo.gameDuration}`,
    `KDA: ${compacted.playerInfo.kda}`,
    `CS: ${compacted.playerInfo.cs} (${compacted.playerInfo.csPerMin}/min)`,
    `Vision: ${compacted.playerInfo.visionScore}`,
    "",
    "=== TEAM COMPS ===",
    `Allies: ${compacted.teamComps.allies}`,
    `Enemies: ${compacted.teamComps.enemies}`,
    `Ally comp tags: ${compacted.teamComps.allyCompTags}`,
    `Enemy comp tags: ${compacted.teamComps.enemyCompTags}`,
    "",
    "=== KEY MOMENTS ===",
    ...compacted.keyMoments.map(
      (moment) =>
        `${moment.timestamp} | ${moment.description} | ${moment.winProbChange} | ${moment.context}`,
    ),
    "",
    "=== GAME STATE SNAPSHOT ===",
    compacted.gameState.minuteByMinute,
    "",
    "=== BUILD PATHS ===",
    `Player build: ${compacted.builds.playerBuild}`,
    `Opponent build: ${compacted.builds.opponentBuild}`,
    "",
    "=== OBJECTIVE SUMMARY ===",
    compacted.objectives,
    "",
    "=== TEAMFIGHTS DETECTED ===",
    ...compacted.teamfights,
    "",
    "=== GOLD EFFICIENCY ISSUES ===",
    ...compacted.goldEfficiencyIssues,
    "",
    "=== RECALL TIMING ===",
    ...compacted.recallTiming,
    "",
    "=== RANK BENCHMARKS ===",
    ...compacted.rankBenchmarks,
    "",
    "=== ABILITY CONTEXT FOR KEY DEATHS ===",
    ...compacted.abilityContext,
    "",
    "=== EXTRA PLAY-BY-PLAY (AI RELEVANT) ===",
    ...compacted.aiRelevantEvents,
    "",
    "=== PLAYER WPA SUMMARY ===",
    ...compacted.wpaSummary,
    "",
    "=== SIMILAR GAME REFERENCE ===",
    ...compacted.similarGameReferences,
    "",
    "=== CONTEXTUAL BUILD (10-CHAMPION THREAT MODEL) ===",
    ...compacted.contextualBuildSummary,
  ];

  return sections.join("\n");
}

// Compatibility alias with previous naming.
export const compactMatchForLlm = compactMatchForLLM;
