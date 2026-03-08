import type {
  MatchDto,
  MatchTimelineDto,
  ParticipantDto,
  TimelineEventDto,
} from "@/lib/types/riot";
import type { GameState, WinProbPoint } from "@/lib/win-probability";
import { calculateWinProbability } from "@/lib/win-probability";

export interface WPAAttribution {
  puuid: string;
  champion: string;
  role: string;
  wpaValue: number;
  attributionType: "killer" | "victim" | "assister" | "objective_participant";
}

export interface WPAEvent {
  eventId: string;
  timestamp: number;
  type: string;
  winProbBefore: number;
  winProbAfter: number;
  delta: number;
  attributions: WPAAttribution[];
}

export interface PlayerWPASummary {
  puuid: string;
  champion: string;
  role: string;
  teamId: number;
  totalWPA: number;
  positiveWPA: number;
  negativeWPA: number;
  biggestPositivePlay: WPAEvent;
  biggestNegativePlay: WPAEvent;
  wpaTimeline: { minute: number; cumulativeWPA: number }[];
  rank: number;
  percentile: number;
}

export interface MatchWPAReport {
  events: WPAEvent[];
  playerSummaries: PlayerWPASummary[];
  mvp: PlayerWPASummary;
  playerContribution: PlayerWPASummary;
}

type ParticipantContext = {
  puuid: string;
  champion: string;
  teamId: number;
  role: string;
};

type TeamState = {
  kills: number;
  towers: number;
  dragons: number;
  inhibitors: number;
  baronExpiresAt: number;
  elderExpiresAt: number;
};

function roleFromParticipant(participant: ParticipantDto): string {
  const byTeamPosition: Record<string, string> = {
    TOP: "TOP",
    JUNGLE: "JUNGLE",
    MIDDLE: "MID",
    BOTTOM: "ADC",
    UTILITY: "SUPPORT",
  };
  if (participant.teamPosition && participant.teamPosition in byTeamPosition) {
    return byTeamPosition[participant.teamPosition];
  }
  if (participant.lane === "JUNGLE") return "JUNGLE";
  if (participant.lane === "MIDDLE") return "MID";
  if (participant.lane === "TOP") return "TOP";
  if (participant.lane === "BOTTOM" && participant.role === "DUO_SUPPORT") return "SUPPORT";
  if (participant.lane === "BOTTOM") return "ADC";
  return "UNKNOWN";
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundWPA(value: number): number {
  return Number(value.toFixed(5));
}

function compareByTimestamp(a: { timestamp: number }, b: { timestamp: number }): number {
  return a.timestamp - b.timestamp;
}

function getRespawnDurationMs(minute: number): number {
  if (minute < 10) return 15_000;
  if (minute < 20) return 25_000;
  if (minute < 30) return 35_000;
  return 45_000;
}

function defaultNeutralEvent(eventId: string): WPAEvent {
  return {
    eventId,
    timestamp: 0,
    type: "NONE",
    winProbBefore: 0.5,
    winProbAfter: 0.5,
    delta: 0,
    attributions: [],
  };
}

export class WPAEngine {
  private playerTeamId = 100;
  private participants = new Map<number, ParticipantContext>();
  private frames: MatchTimelineDto["info"]["frames"] = [];
  private lastDeathTimestamp = new Map<number, number>();

  computeMatchWPA(
    match: MatchDto,
    timeline: MatchTimelineDto,
    winProbTimeline: WinProbPoint[],
    playerPuuid: string,
  ): MatchWPAReport {
    const playerParticipant = match.info.participants.find(
      (participant) => participant.puuid === playerPuuid,
    );
    this.playerTeamId = playerParticipant?.teamId ?? 100;
    this.participants.clear();
    this.lastDeathTimestamp.clear();
    this.frames = [...timeline.info.frames].sort((a, b) => a.timestamp - b.timestamp);

    for (const participant of match.info.participants) {
      this.participants.set(participant.participantId, {
        puuid: participant.puuid,
        champion: participant.championName,
        teamId: participant.teamId,
        role: roleFromParticipant(participant),
      });
    }

    const significantEvents = this.frames
      .flatMap((frame) => frame.events)
      .filter((event) =>
        ["CHAMPION_KILL", "BUILDING_KILL", "ELITE_MONSTER_KILL"].includes(event.type),
      )
      .sort(compareByTimestamp);

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

    const perPlayerTotals = new Map<
      string,
      {
        champion: string;
        role: string;
        teamId: number;
        total: number;
        positive: number;
        negative: number;
      }
    >();
    const perPlayerEventContrib = new Map<
      string,
      Array<{ event: WPAEvent; value: number }>
    >();

    for (const participant of this.participants.values()) {
      perPlayerTotals.set(participant.puuid, {
        champion: participant.champion,
        role: participant.role,
        teamId: participant.teamId,
        total: 0,
        positive: 0,
        negative: 0,
      });
      perPlayerEventContrib.set(participant.puuid, []);
    }

    const wpaEvents: WPAEvent[] = [];

    for (let index = 0; index < significantEvents.length; index += 1) {
      const event = significantEvents[index];
      const frame = this.getNearestFrameAtOrBefore(event.timestamp);
      const gameStateBefore = this.buildGameState(event.timestamp, frame, teamState);
      const teamStateAfter = this.cloneTeamState(teamState);
      this.applyEventToTeamState(event, teamStateAfter);
      const gameStateAfter = this.buildGameState(event.timestamp, frame, teamStateAfter);

      const eventWPA = this.computeEventWPA(event, gameStateBefore, gameStateAfter);
      const attributions = this.attributeWPA(event, eventWPA.delta, this.participants);
      if (attributions.length > 0) {
        const wpaEvent: WPAEvent = {
          eventId: `wpa-${event.timestamp}-${index + 1}`,
          timestamp: event.timestamp,
          type: event.type,
          winProbBefore: eventWPA.before,
          winProbAfter: eventWPA.after,
          delta: roundWPA(eventWPA.delta),
          attributions: attributions.map((attribution) => ({
            ...attribution,
            wpaValue: roundWPA(attribution.wpaValue),
          })),
        };
        wpaEvents.push(wpaEvent);

        for (const attribution of wpaEvent.attributions) {
          const total = perPlayerTotals.get(attribution.puuid);
          if (!total) continue;
          total.total += attribution.wpaValue;
          if (attribution.wpaValue >= 0) {
            total.positive += attribution.wpaValue;
          } else {
            total.negative += attribution.wpaValue;
          }
          perPlayerEventContrib.get(attribution.puuid)?.push({
            event: wpaEvent,
            value: attribution.wpaValue,
          });
        }
      }

      if (event.type === "CHAMPION_KILL" && typeof event.victimId === "number") {
        this.lastDeathTimestamp.set(event.victimId, event.timestamp);
      }

      teamState[100] = teamStateAfter[100];
      teamState[200] = teamStateAfter[200];
    }

    const summaries: PlayerWPASummary[] = [];
    for (const [puuid, totals] of perPlayerTotals.entries()) {
      const contribEvents = perPlayerEventContrib.get(puuid) ?? [];
      const biggestPositive = contribEvents
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value)[0]?.event;
      const biggestNegative = contribEvents
        .filter((entry) => entry.value < 0)
        .sort((a, b) => a.value - b.value)[0]?.event;

      summaries.push({
        puuid,
        champion: totals.champion,
        role: totals.role,
        teamId: totals.teamId,
        totalWPA: roundWPA(totals.total),
        positiveWPA: roundWPA(totals.positive),
        negativeWPA: roundWPA(totals.negative),
        biggestPositivePlay: biggestPositive ?? defaultNeutralEvent("neutral-positive"),
        biggestNegativePlay: biggestNegative ?? defaultNeutralEvent("neutral-negative"),
        wpaTimeline: this.buildPlayerTimeline(wpaEvents, puuid),
        rank: 0,
        percentile: 50,
      });
    }

    const ranked = this.rankPlayers(summaries);
    const mvp = ranked[0] ?? {
      puuid: playerPuuid,
      champion: playerParticipant?.championName ?? "Unknown",
      role: playerParticipant ? roleFromParticipant(playerParticipant) : "UNKNOWN",
      teamId: playerParticipant?.teamId ?? 100,
      totalWPA: 0,
      positiveWPA: 0,
      negativeWPA: 0,
      biggestPositivePlay: defaultNeutralEvent("mvp-positive"),
      biggestNegativePlay: defaultNeutralEvent("mvp-negative"),
      wpaTimeline: [{ minute: 0, cumulativeWPA: 0 }],
      rank: 1,
      percentile: 50,
    };
    const playerContribution =
      ranked.find((summary) => summary.puuid === playerPuuid) ?? mvp;

    return {
      events: wpaEvents,
      playerSummaries: ranked,
      mvp,
      playerContribution,
    };
  }

  private computeEventWPA(
    _event: TimelineEventDto,
    gameStateBefore: GameState,
    gameStateAfter: GameState,
  ): { delta: number; before: number; after: number } {
    const before = clampProbability(calculateWinProbability(gameStateBefore));
    const after = clampProbability(calculateWinProbability(gameStateAfter));
    return {
      delta: after - before,
      before,
      after,
    };
  }

  private attributeWPA(
    event: TimelineEventDto,
    wpaDelta: number,
    participants: Map<number, ParticipantContext>,
  ): WPAAttribution[] {
    if (Math.abs(wpaDelta) < 0.0005) {
      return [];
    }

    if (event.type === "CHAMPION_KILL") {
      const killer = typeof event.killerId === "number" ? participants.get(event.killerId) : null;
      const victim = typeof event.victimId === "number" ? participants.get(event.victimId) : null;
      const killerTeamId = killer?.teamId ?? null;
      if (!killer || !victim || !killerTeamId) {
        return [];
      }

      const killerTeamImpact =
        killerTeamId === this.playerTeamId ? wpaDelta : -wpaDelta;
      const attributions: WPAAttribution[] = [
        {
          puuid: killer.puuid,
          champion: killer.champion,
          role: killer.role,
          wpaValue: killerTeamImpact,
          attributionType: "killer",
        },
        {
          puuid: victim.puuid,
          champion: victim.champion,
          role: victim.role,
          wpaValue: -killerTeamImpact,
          attributionType: "victim",
        },
      ];

      const assisters = (event.assistingParticipantIds ?? [])
        .map((id) => participants.get(id))
        .filter((entry): entry is ParticipantContext => Boolean(entry));
      if (assisters.length > 0) {
        const assisterShare = (killerTeamImpact * 0.5) / assisters.length;
        for (const assister of assisters) {
          attributions.push({
            puuid: assister.puuid,
            champion: assister.champion,
            role: assister.role,
            wpaValue: assisterShare,
            attributionType: "assister",
          });
        }
      }

      return attributions;
    }

    if (event.type === "BUILDING_KILL" || event.type === "ELITE_MONSTER_KILL") {
      const killer = typeof event.killerId === "number" ? participants.get(event.killerId) : null;
      const killerTeamId =
        killer?.teamId ??
        (typeof event.teamId === "number" ? event.teamId : null);
      if (!killerTeamId) {
        return [];
      }

      const eventTeamImpact =
        killerTeamId === this.playerTeamId ? wpaDelta : -wpaDelta;
      const nearbyOrAlive = this.getLikelyAliveParticipantsOnTeam(killerTeamId, event.timestamp);
      const participantsPool = nearbyOrAlive.length > 0
        ? nearbyOrAlive
        : [...participants.entries()]
            .filter(([, participant]) => participant.teamId === killerTeamId)
            .map(([participantId]) => participantId);

      const attributionRows: WPAAttribution[] = [];
      if (event.type === "BUILDING_KILL") {
        const share = eventTeamImpact / Math.max(1, participantsPool.length);
        for (const participantId of participantsPool) {
          const participant = participants.get(participantId);
          if (!participant) continue;
          attributionRows.push({
            puuid: participant.puuid,
            champion: participant.champion,
            role: participant.role,
            wpaValue: share,
            attributionType: "objective_participant",
          });
        }
        return attributionRows;
      }

      const killerParticipant =
        typeof event.killerId === "number" ? participants.get(event.killerId) : null;
      if (killerParticipant) {
        attributionRows.push({
          puuid: killerParticipant.puuid,
          champion: killerParticipant.champion,
          role: killerParticipant.role,
          wpaValue: eventTeamImpact * 0.4,
          attributionType: "objective_participant",
        });
      }

      const nearbyParticipants = this.getNearbyParticipants(
        participantsPool,
        event.timestamp,
        event.position,
      ).filter((participantId) => participantId !== event.killerId);
      const fallbackParticipants = participantsPool.filter(
        (participantId) => participantId !== event.killerId,
      );
      const shareTargets = nearbyParticipants.length > 0 ? nearbyParticipants : fallbackParticipants;
      if (shareTargets.length === 0) {
        if (attributionRows[0]) {
          attributionRows[0].wpaValue = eventTeamImpact;
        }
        return attributionRows;
      }

      const participantShare = (eventTeamImpact * 0.6) / shareTargets.length;
      for (const participantId of shareTargets) {
        const participant = participants.get(participantId);
        if (!participant) continue;
        attributionRows.push({
          puuid: participant.puuid,
          champion: participant.champion,
          role: participant.role,
          wpaValue: participantShare,
          attributionType: "objective_participant",
        });
      }

      return attributionRows;
    }

    return [];
  }

  private buildPlayerTimeline(
    events: WPAEvent[],
    puuid: string,
  ): { minute: number; cumulativeWPA: number }[] {
    const deltaByMinute = new Map<number, number>();
    for (const event of events) {
      const contribution = event.attributions
        .filter((attribution) => attribution.puuid === puuid)
        .reduce((sum, attribution) => sum + attribution.wpaValue, 0);
      if (contribution === 0) {
        continue;
      }

      const minute = Math.floor(event.timestamp / 60_000);
      deltaByMinute.set(minute, (deltaByMinute.get(minute) ?? 0) + contribution);
    }

    if (deltaByMinute.size === 0) {
      return [{ minute: 0, cumulativeWPA: 0 }];
    }

    const points: { minute: number; cumulativeWPA: number }[] = [{ minute: 0, cumulativeWPA: 0 }];
    let cumulative = 0;
    for (const minute of [...deltaByMinute.keys()].sort((a, b) => a - b)) {
      cumulative += deltaByMinute.get(minute) ?? 0;
      points.push({
        minute,
        cumulativeWPA: roundWPA(cumulative),
      });
    }

    return points;
  }

  private rankPlayers(summaries: PlayerWPASummary[]): PlayerWPASummary[] {
    const ranked = [...summaries].sort((a, b) => b.totalWPA - a.totalWPA);
    const totalPlayers = Math.max(1, ranked.length);
    return ranked.map((summary, index) => {
      const rank = index + 1;
      const rankPercentile = ((totalPlayers - index) / totalPlayers) * 100;
      const impactAdjustment = summary.totalWPA * 250;
      const percentile = Math.max(
        1,
        Math.min(99, Math.round(rankPercentile * 0.7 + 30 + impactAdjustment)),
      );
      return {
        ...summary,
        rank,
        percentile,
      };
    });
  }

  private cloneTeamState(teamState: Record<number, TeamState>): Record<number, TeamState> {
    return {
      100: { ...teamState[100] },
      200: { ...teamState[200] },
    };
  }

  private applyEventToTeamState(
    event: TimelineEventDto,
    teamState: Record<number, TeamState>,
  ): void {
    const killerTeamId = this.getEventTeamId(event);
    if (!killerTeamId) {
      return;
    }

    if (event.type === "CHAMPION_KILL") {
      teamState[killerTeamId].kills += 1;
      return;
    }

    if (event.type === "BUILDING_KILL") {
      if (event.buildingType === "TOWER_BUILDING") {
        teamState[killerTeamId].towers += 1;
      }
      if (event.buildingType === "INHIBITOR_BUILDING") {
        teamState[killerTeamId].inhibitors += 1;
      }
      return;
    }

    if (event.type !== "ELITE_MONSTER_KILL") {
      return;
    }

    if (event.monsterType === "DRAGON") {
      teamState[killerTeamId].dragons += 1;
      return;
    }

    if (event.monsterType === "ELDER_DRAGON") {
      teamState[killerTeamId].elderExpiresAt = event.timestamp + 150_000;
      return;
    }

    if (event.monsterType === "BARON_NASHOR") {
      teamState[killerTeamId].baronExpiresAt = event.timestamp + 180_000;
    }
  }

  private getEventTeamId(event: TimelineEventDto): number | null {
    if (typeof event.killerId === "number") {
      const fromKiller = this.participants.get(event.killerId)?.teamId;
      if (fromKiller) return fromKiller;
    }
    if (typeof event.teamId === "number") {
      return event.teamId;
    }
    return null;
  }

  private getNearestFrameAtOrBefore(
    timestamp: number,
  ): MatchTimelineDto["info"]["frames"][number] | null {
    let candidate: MatchTimelineDto["info"]["frames"][number] | null = null;
    for (const frame of this.frames) {
      if (frame.timestamp <= timestamp) {
        candidate = frame;
      } else {
        break;
      }
    }
    return candidate ?? this.frames[0] ?? null;
  }

  private buildGameState(
    timestamp: number,
    frame: MatchTimelineDto["info"]["frames"][number] | null,
    teamState: Record<number, TeamState>,
  ): GameState {
    const enemyTeamId = this.playerTeamId === 100 ? 200 : 100;
    let playerGold = 0;
    let enemyGold = 0;
    let playerXp = 0;
    let enemyXp = 0;

    if (frame) {
      for (const participantFrame of Object.values(frame.participantFrames)) {
        const teamId = this.participants.get(participantFrame.participantId)?.teamId;
        if (teamId === this.playerTeamId) {
          playerGold += participantFrame.totalGold;
          playerXp += participantFrame.xp;
        } else if (teamId === enemyTeamId) {
          enemyGold += participantFrame.totalGold;
          enemyXp += participantFrame.xp;
        }
      }
    }

    return {
      minute: Math.floor(timestamp / 60_000),
      goldDiff: playerGold - enemyGold,
      xpDiff: playerXp - enemyXp,
      killDiff: teamState[this.playerTeamId].kills - teamState[enemyTeamId].kills,
      towerDiff: teamState[this.playerTeamId].towers - teamState[enemyTeamId].towers,
      dragonDiff: teamState[this.playerTeamId].dragons - teamState[enemyTeamId].dragons,
      baronActive: teamState[this.playerTeamId].baronExpiresAt > timestamp,
      elderActive: teamState[this.playerTeamId].elderExpiresAt > timestamp,
      inhibsDown: teamState[this.playerTeamId].inhibitors,
    };
  }

  private getLikelyAliveParticipantsOnTeam(teamId: number, timestamp: number): number[] {
    const minute = Math.floor(timestamp / 60_000);
    const respawnDuration = getRespawnDurationMs(minute);
    const alive: number[] = [];
    for (const [participantId, participant] of this.participants.entries()) {
      if (participant.teamId !== teamId) continue;
      const lastDeath = this.lastDeathTimestamp.get(participantId);
      if (!lastDeath || timestamp - lastDeath > respawnDuration) {
        alive.push(participantId);
      }
    }
    return alive;
  }

  private getNearbyParticipants(
    participantIds: number[],
    timestamp: number,
    position: { x: number; y: number } | undefined,
  ): number[] {
    if (!position) {
      return participantIds;
    }

    const frame = this.getNearestFrameAtOrBefore(timestamp);
    if (!frame) {
      return participantIds;
    }

    return participantIds.filter((participantId) => {
      const participantFrame = frame.participantFrames[String(participantId)];
      if (!participantFrame?.position) {
        return false;
      }

      const dx = participantFrame.position.x - position.x;
      const dy = participantFrame.position.y - position.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      return distance <= 4000;
    });
  }
}

export const wpaEngine = new WPAEngine();

