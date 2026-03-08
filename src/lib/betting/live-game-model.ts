import type { CompTag } from "@/lib/comp-classifier";

export interface LiveGameState {
  timestamp: number;
  team1Gold: number;
  team2Gold: number;
  goldDiff: number;
  team1Dragons: number;
  team2Dragons: number;
  team1Towers: number;
  team2Towers: number;
  team1Barons: number;
  team2Barons: number;
  team1Heralds: number;
  team2Heralds: number;
  team1DragonSoul: boolean;
  elderDragonActive: boolean;
  roleGoldDiff: {
    top: number;
    jungle: number;
    mid: number;
    adc: number;
    support: number;
  };
  team1Kills: number;
  team2Kills: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class LiveGameModel {
  async predictLive(
    state: LiveGameState,
    team1Comp: string[],
    team2Comp: string[],
    team1CompTags: CompTag[],
    team2CompTags: CompTag[],
  ): Promise<{ team1WinProb: number; factors: string[] }> {
    let baseProbability = 0.5;

    const goldFactor = this.goldDiffToProb(state.goldDiff, state.timestamp);
    const roleWeightedGold = this.roleWeightedGoldDiff(state.roleGoldDiff);
    const scalingAdjustment = this.scalingAdjustment(
      state.timestamp,
      team1CompTags,
      team2CompTags,
    );
    const objectiveFactor = this.objectiveValue(state);
    const momentumFactor = this.detectMomentum(state);

    baseProbability +=
      goldFactor +
      roleWeightedGold +
      scalingAdjustment +
      objectiveFactor +
      momentumFactor;

    return {
      team1WinProb: clamp(baseProbability, 0.02, 0.98),
      factors: this.explainFactors(
        goldFactor,
        roleWeightedGold,
        scalingAdjustment,
        objectiveFactor,
        momentumFactor,
      ),
    };
  }

  private goldDiffToProb(goldDiff: number, gameTimeSeconds: number): number {
    const minute = gameTimeSeconds / 60;
    const timeWeight = minute < 15 ? 1.2 : minute < 25 ? 1 : 0.8;
    const scaled = clamp(goldDiff / 7000, -1, 1) * 0.12 * timeWeight;
    return clamp(scaled, -0.2, 0.2);
  }

  private normalizeGoldToProb(weightedDiff: number): number {
    return clamp(weightedDiff / 9000, -0.08, 0.08);
  }

  private roleWeightedGoldDiff(roleGold: LiveGameState["roleGoldDiff"]): number {
    const weights = {
      adc: 0.3,
      mid: 0.25,
      top: 0.2,
      jungle: 0.15,
      support: 0.1,
    } as const;

    let weightedDiff = 0;
    for (const [role, diff] of Object.entries(roleGold)) {
      const key = role as keyof typeof weights;
      weightedDiff += diff * (weights[key] ?? 0.15);
    }
    return this.normalizeGoldToProb(weightedDiff);
  }

  private scalingAdjustment(
    gameTime: number,
    team1Tags: CompTag[],
    team2Tags: CompTag[],
  ): number {
    const team1Scaling = team1Tags.includes("scaling_comp")
      ? 1
      : team1Tags.includes("early_game")
        ? -1
        : 0;
    const team2Scaling = team2Tags.includes("scaling_comp")
      ? 1
      : team2Tags.includes("early_game")
        ? -1
        : 0;

    if (gameTime < 20 * 60) {
      const scalingBonus = (team1Scaling - team2Scaling) * 0.03;
      const timeFactor = 1 - gameTime / (30 * 60);
      return clamp(scalingBonus * timeFactor, -0.06, 0.06);
    }

    return 0;
  }

  private objectiveValue(state: LiveGameState): number {
    let value = 0;

    const dragonDiff = state.team1Dragons - state.team2Dragons;
    const towerDiff = state.team1Towers - state.team2Towers;
    const baronDiff = state.team1Barons - state.team2Barons;
    const heraldDiff = state.team1Heralds - state.team2Heralds;

    value += dragonDiff * 0.012;
    value += towerDiff * 0.009;
    value += baronDiff * 0.045;
    value += heraldDiff * 0.006;

    if (state.team1DragonSoul) {
      value += 0.08;
    }

    if (state.elderDragonActive) {
      // Elder mostly converts through execution pressure: large but temporary.
      value += dragonDiff >= 0 ? 0.04 : -0.04;
    }

    return clamp(value, -0.22, 0.22);
  }

  private detectMomentum(state: LiveGameState): number {
    const killDiff = state.team1Kills - state.team2Kills;
    const minute = state.timestamp / 60;

    const shortWindowBias = minute < 12 ? 0.7 : 1;
    return clamp((killDiff / 10) * 0.03 * shortWindowBias, -0.04, 0.04);
  }

  private explainFactors(
    goldFactor: number,
    roleWeightedGold: number,
    scalingAdjustment: number,
    objectiveFactor: number,
    momentumFactor: number,
  ): string[] {
    return [
      `Raw gold contribution: ${(goldFactor * 100).toFixed(1)}%`,
      `Role-weighted gold contribution: ${(roleWeightedGold * 100).toFixed(1)}%`,
      `Scaling adjustment: ${(scalingAdjustment * 100).toFixed(1)}%`,
      `Objective value adjustment: ${(objectiveFactor * 100).toFixed(1)}%`,
      `Momentum adjustment: ${(momentumFactor * 100).toFixed(1)}%`,
    ];
  }
}

export const liveGameModel = new LiveGameModel();
