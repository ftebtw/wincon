import { NextResponse } from "next/server";

import {
  contextualBuildEngine,
  getChampionClass,
} from "@/lib/contextual-build-engine";

type BuildRequestBody = {
  champion?: string;
  role?: string;
  allies?: string[];
  enemies?: string[];
};

export async function POST(request: Request) {
  let body: BuildRequestBody;
  try {
    body = (await request.json()) as BuildRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const champion = body.champion?.trim();
  const role = body.role?.trim().toUpperCase();
  const allies = (body.allies ?? []).map((entry) => entry.trim()).filter(Boolean);
  const enemies = (body.enemies ?? []).map((entry) => entry.trim()).filter(Boolean);

  if (!champion || !role) {
    return NextResponse.json(
      { error: "Missing required fields: champion, role." },
      { status: 400 },
    );
  }

  if (enemies.length !== 5) {
    return NextResponse.json(
      { error: "Expected exactly 5 enemies for contextual build analysis." },
      { status: 400 },
    );
  }

  try {
    const recommendation = await contextualBuildEngine.generateBuild({
      playerChampion: champion,
      playerRole: role,
      playerClass: await getChampionClass(champion),
      allies,
      enemies,
    });

    return NextResponse.json(recommendation);
  } catch (error) {
    console.error("[ContextualBuildRoute] Failed to generate build:", error);
    return NextResponse.json(
      { error: "Failed to generate contextual build recommendation." },
      { status: 500 },
    );
  }
}
