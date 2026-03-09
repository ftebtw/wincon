export interface AccountDto {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface SummonerDto {
  id?: string;
  accountId?: string;
  puuid: string;
  profileIconId: number;
  revisionDate: number;
  summonerLevel: number;
}

export interface LeagueEntryDto {
  leagueId: string;
  summonerId?: string;
  summonerName?: string;
  puuid?: string;
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  veteran: boolean;
  inactive: boolean;
  freshBlood: boolean;
  hotStreak: boolean;
  miniSeries?: {
    losses: number;
    progress: string;
    target: number;
    wins: number;
  };
}

export type HighEloTier = "CHALLENGER" | "GRANDMASTER" | "MASTER";

export interface LeagueListEntryDto {
  summonerId?: string;
  summonerName?: string;
  puuid?: string;
  leaguePoints: number;
  rank: string;
  wins: number;
  losses: number;
  veteran: boolean;
  inactive: boolean;
  freshBlood: boolean;
  hotStreak: boolean;
}

export interface LeagueListDto {
  leagueId: string;
  name: string;
  queue: string;
  tier: string;
  entries: LeagueListEntryDto[];
}

export interface PerkStyleSelectionDto {
  perk: number;
  var1: number;
  var2: number;
  var3: number;
}

export interface PerkStyleDto {
  description: string;
  style: number;
  selections: PerkStyleSelectionDto[];
}

export interface ParticipantPerksDto {
  statPerks: {
    defense: number;
    flex: number;
    offense: number;
  };
  styles: PerkStyleDto[];
}

export interface ParticipantDto {
  puuid: string;
  summonerName: string;
  riotIdGameName: string;
  riotIdTagline: string;
  participantId: number;
  championId: number;
  championName: string;
  champLevel: number;
  teamId: 100 | 200;
  teamPosition: "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | "";
  lane?: string;
  role?: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  goldEarned: number;
  goldSpent: number;
  totalDamageDealtToChampions: number;
  totalDamageTaken: number;
  magicDamageDealtToChampions: number;
  physicalDamageDealtToChampions: number;
  visionScore: number;
  wardsPlaced: number;
  wardsKilled: number;
  visionWardsBoughtInGame: number;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
  summoner1Id: number;
  summoner2Id: number;
  perks: ParticipantPerksDto;
  firstBloodKill: boolean;
  firstBloodAssist: boolean;
  firstTowerKill: boolean;
  firstTowerAssist: boolean;
  turretKills: number;
  inhibitorKills: number;
  dragonKills: number;
  baronKills: number;
  damageDealtToTurrets: number;
  damageDealtToObjectives: number;
  totalHealsOnTeammates: number;
  totalDamageShieldedOnTeammates: number;
  timeCCingOthers: number;
}

export interface TeamBanDto {
  championId: number;
  pickTurn: number;
}

export interface TeamObjectiveDto {
  first: boolean;
  kills: number;
}

export interface TeamObjectivesDto {
  baron: TeamObjectiveDto;
  champion: TeamObjectiveDto;
  dragon: TeamObjectiveDto;
  inhibitor: TeamObjectiveDto;
  riftHerald: TeamObjectiveDto;
  tower: TeamObjectiveDto;
  [key: string]: TeamObjectiveDto;
}

export interface TeamDto {
  teamId: number;
  win: boolean;
  bans: TeamBanDto[];
  objectives: TeamObjectivesDto;
}

export interface MatchDto {
  metadata: {
    dataVersion: string;
    matchId: string;
    participants: string[];
  };
  info: {
    gameCreation: number;
    gameDuration: number;
    gameEndTimestamp: number;
    gameId: number;
    gameMode: string;
    gameName: string;
    gameStartTimestamp: number;
    gameType: string;
    gameVersion: string;
    mapId: number;
    participants: ParticipantDto[];
    platformId: string;
    queueId: number;
    teams: TeamDto[];
    tournamentCode: string;
  };
}

export interface TimelineChampionStatsDto {
  abilityPower: number;
  armor: number;
  attackDamage: number;
  attackSpeed: number;
  health: number;
  healthMax: number;
  healthRegen: number;
  magicResist: number;
  movementSpeed: number;
  power: number;
  powerMax: number;
  powerRegen: number;
  [key: string]: number;
}

export interface TimelineDamageStatsDto {
  magicDamageDone: number;
  magicDamageDoneToChampions: number;
  magicDamageTaken: number;
  physicalDamageDone: number;
  physicalDamageDoneToChampions: number;
  physicalDamageTaken: number;
  totalDamageDone: number;
  totalDamageDoneToChampions: number;
  totalDamageTaken: number;
  trueDamageDone: number;
  trueDamageDoneToChampions: number;
  trueDamageTaken: number;
  [key: string]: number;
}

export interface ParticipantFrameDto {
  participantId: number;
  position: {
    x: number;
    y: number;
  };
  currentGold: number;
  totalGold: number;
  xp: number;
  minionsKilled: number;
  jungleMinionsKilled: number;
  level: number;
  championStats: TimelineChampionStatsDto;
  damageStats: TimelineDamageStatsDto;
}

export interface TimelineEventDto {
  type: string;
  timestamp: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  position?: {
    x: number;
    y: number;
  };
  itemId?: number;
  wardType?: string;
  monsterType?: string;
  monsterSubType?: string;
  buildingType?: string;
  towerType?: string;
  laneType?: string;
  teamId?: number;
  bounty?: number;
  shutdownBounty?: number;
  skillSlot?: number;
  levelUpType?: string;
  [key: string]: unknown;
}

export interface TimelineFrameDto {
  timestamp: number;
  participantFrames: Record<string, ParticipantFrameDto>;
  events: TimelineEventDto[];
}

export interface MatchTimelineDto {
  metadata: {
    matchId: string;
    participants: string[];
  };
  info: {
    frameInterval: number;
    frames: TimelineFrameDto[];
    participants: {
      participantId: number;
      puuid: string;
    }[];
  };
}

export interface CurrentGameBanDto {
  championId: number;
  teamId: number;
  pickTurn: number;
}

export interface CurrentGameParticipantDto {
  puuid: string;
  teamId: number;
  championId: number;
  profileIconId: number;
  bot: boolean;
  summonerId: string;
  gameCustomizationObjects: unknown[];
  perks: {
    perkIds: number[];
    perkStyle: number;
    perkSubStyle: number;
  };
  spell1Id: number;
  spell2Id: number;
}

export interface CurrentGameInfoDto {
  gameId: number;
  mapId: number;
  gameMode: string;
  gameType: string;
  gameQueueConfigId: number;
  participants: CurrentGameParticipantDto[];
  observers: {
    encryptionKey: string;
  };
  platformId: string;
  bannedChampions: CurrentGameBanDto[];
  gameStartTime: number;
  gameLength: number;
}

export interface ChampionMasteryDto {
  puuid: string;
  championId: number;
  championLevel: number;
  championPoints: number;
  lastPlayTime: number;
  championPointsSinceLastLevel: number;
  championPointsUntilNextLevel: number;
}

// Compatibility aliases for existing scaffolded modules.
export type RiotAccountResponse = AccountDto;
export type RiotSummonerResponse = SummonerDto;
export type RiotParticipant = ParticipantDto;
export type RiotTeam = TeamDto;
export type RiotMatch = MatchDto;
export type MatchParticipantFrame = ParticipantFrameDto;
export type MatchEvent = TimelineEventDto;
export type MatchFrame = TimelineFrameDto;
export type RiotTimeline = MatchTimelineDto;
export type CurrentGameParticipant = CurrentGameParticipantDto;
export type RiotCurrentGame = CurrentGameInfoDto;
