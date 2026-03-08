import { NextResponse } from "next/server";

import { getProBuildsForChampion } from "@/lib/pro-insights";

type ProBuildRouteContext = {
  params: Promise<{
    champion: string;
  }>;
};

export async function GET(request: Request, { params }: ProBuildRouteContext) {
  const { champion } = await params;
  const championName = decodeURIComponent(champion);

  const { searchParams } = new URL(request.url);
  const role = searchParams.get("role") ?? "MID";
  const league = searchParams.get("league") ?? undefined;
  const patch = searchParams.get("patch") ?? undefined;
  const recentGames = Number(searchParams.get("recentGames") ?? 300);

  const builds = await getProBuildsForChampion({
    champion: championName,
    role,
    league,
    patch,
    recentGames,
  });

  return NextResponse.json({
    champion: championName,
    role,
    league,
    patch,
    builds,
  });
}