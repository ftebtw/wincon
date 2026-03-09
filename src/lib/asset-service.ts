import { getChampionById, getLatestVersion } from "@/lib/data-dragon";
import { cdragonService } from "@/lib/cdragon";

export class AssetService {
  async getChampionIcon(championId: number): Promise<string> {
    try {
      const version = await getLatestVersion();
      const champion = await getChampionById(championId);
      if (champion?.id) {
        return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champion.id}.png`;
      }
    } catch {
      // Fallback below.
    }

    return cdragonService.getAssetUrl(
      `/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`,
      "latest",
    );
  }

  getChampionSplash(championId: number, skinNum = 0): string {
    const padded = String(skinNum).padStart(3, "0");
    return cdragonService.getAssetUrl(
      `/plugins/rcp-be-lol-game-data/global/default/v1/champion-splashes/${championId}/${championId}${padded}.jpg`,
      "latest",
    );
  }

  getChampionLoadingScreen(championId: number, skinNum = 0): string {
    const padded = String(skinNum).padStart(3, "0");
    return cdragonService.getAssetUrl(
      `/plugins/rcp-be-lol-game-data/global/default/v1/champion-splash-uncentered/${championId}/${championId}${padded}.jpg`,
      "latest",
    );
  }

  getAbilityIcon(championAlias: string, abilitySlot: "P" | "Q" | "W" | "E" | "R"): string {
    const alias = championAlias.toLowerCase();
    const slot = abilitySlot === "P" ? "passive" : abilitySlot.toLowerCase();
    return cdragonService.getAssetUrl(
      `/game/assets/characters/${alias}/hud/icons2d/${alias}_${slot}.png`,
      "latest",
    );
  }
}

export const assetService = new AssetService();
