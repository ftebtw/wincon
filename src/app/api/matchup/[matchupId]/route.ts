import { NextResponse } from "next/server";

import { getChampionByName } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import { parseMatchupId } from "@/lib/matchup-id";
import { matchupGuideService } from "@/lib/matchup-guide";
import { patchTracker } from "@/lib/patch-tracker";
import { and, eq } from "drizzle-orm";

type MatchupRouteContext = {
  params: Promise<{
    matchupId: string;
  }>;
};

export async function GET(_request: Request, { params }: MatchupRouteContext) {
  const { matchupId } = await params;
  const parsed = parseMatchupId(matchupId);

  if (!parsed) {
    return NextResponse.json({ error: "Invalid matchup id." }, { status: 400 });
  }

  try {
    const currentPatch = await patchTracker.getCurrentPatch();

    if (process.env.DATABASE_URL) {
      const cached = await db
        .select({
          guideJson: schema.matchupGuides.guideJson,
        })
        .from(schema.matchupGuides)
        .where(
          and(
            eq(schema.matchupGuides.id, matchupId),
            eq(schema.matchupGuides.patch, currentPatch),
          ),
        )
        .limit(1);

      if (cached[0]?.guideJson) {
        return NextResponse.json(cached[0].guideJson, {
          headers: { "x-matchup-cache": "hit" },
        });
      }
    }

    const [championData, enemyData] = await Promise.all([
      getChampionByName(parsed.champion).catch(() => undefined),
      getChampionByName(parsed.enemy).catch(() => undefined),
    ]);

    const guide = await matchupGuideService.getGuide(
      championData?.name ?? parsed.champion,
      parsed.role,
      enemyData?.name ?? parsed.enemy,
      parsed.enemyRole,
    );

    return NextResponse.json(guide, {
      headers: { "x-matchup-cache": "miss" },
    });
  } catch (error) {
    console.error("[MatchupRoute] Failed to resolve matchup guide:", error);
    return NextResponse.json(
      { error: "Failed to generate matchup guide." },
      { status: 500 },
    );
  }
}
