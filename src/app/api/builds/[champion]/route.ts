import { NextResponse } from "next/server";

import { getOptimalBuild } from "@/lib/build-analyzer";
import { classifyBothComps } from "@/lib/comp-classifier";
import {
  contextualBuildEngine,
  getChampionClass,
} from "@/lib/contextual-build-engine";

type BuildRouteContext = {
  params: Promise<{
    champion: string;
  }>;
};

function parseChampionList(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function GET(request: Request, { params }: BuildRouteContext) {
  const { champion } = await params;
  const url = new URL(request.url);
  const role = url.searchParams.get("role")?.trim() ?? "";
  const patch = url.searchParams.get("patch")?.trim() ?? undefined;
  const allies = parseChampionList(url.searchParams.get("allies"));
  const enemies = parseChampionList(url.searchParams.get("enemies"));

  if (!role) {
    return NextResponse.json(
      { error: "Missing required query parameter: role" },
      { status: 400 },
    );
  }

  if (allies.length === 0 || enemies.length === 0) {
    return NextResponse.json(
      {
        error:
          "Missing required query parameters: allies and enemies (comma-separated champion names).",
      },
      { status: 400 },
    );
  }

  const championName = decodeURIComponent(champion);

  try {
    const compAnalysis = await classifyBothComps(allies, enemies);
    const [recommendation, contextualRecommendation] = await Promise.all([
      getOptimalBuild({
        championName,
        role,
        allyCompTags: compAnalysis.ally.tags,
        enemyCompTags: compAnalysis.enemy.tags,
        patch,
      }),
      contextualBuildEngine.generateBuild({
        playerChampion: championName,
        playerRole: role,
        playerClass: await getChampionClass(championName),
        allies: allies.filter((ally) => ally !== championName).slice(0, 4),
        enemies: enemies.slice(0, 5),
      }),
    ]);

    return NextResponse.json({
      recommendation,
      contextualRecommendation,
      compAnalysis,
    });
  } catch (error) {
    console.error("[BuildRoute] Failed to compute recommendation:", error);
    return NextResponse.json(
      { error: "Failed to build composition-aware recommendation." },
      { status: 500 },
    );
  }
}
