import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db, schema } from "@/lib/db";

type ProMatchDetailPageProps = {
  params: Promise<{
    gameId: string;
  }>;
};

function duration(seconds: number | null): string {
  if (!seconds || seconds <= 0) {
    return "-";
  }
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${String(sec).padStart(2, "0")}s`;
}

export default async function ProMatchDetailPage({ params }: ProMatchDetailPageProps) {
  const { gameId } = await params;
  const decodedGameId = decodeURIComponent(gameId);

  const [match] = await db
    .select()
    .from(schema.proMatches)
    .where(eq(schema.proMatches.gameId, decodedGameId))
    .limit(1);

  if (!match) {
    notFound();
  }

  const stats = await db
    .select()
    .from(schema.proPlayerStats)
    .where(eq(schema.proPlayerStats.gameId, decodedGameId))
    .orderBy(asc(schema.proPlayerStats.position));

  const blueTeamName = match.blueTeam;
  const redTeamName = match.redTeam;

  const blueRows = stats.filter((row) => row.teamName === blueTeamName && row.position !== "TEAM");
  const redRows = stats.filter((row) => row.teamName === redTeamName && row.position !== "TEAM");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-2xl">{blueTeamName} vs {redTeamName}</CardTitle>
            <Badge variant="secondary">{match.league}</Badge>
            <Badge variant="outline">Patch {match.patch ?? "-"}</Badge>
            <Badge variant="outline">{duration(match.gameDuration)}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">Winner: {match.winner}</p>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{blueTeamName}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {blueRows.map((row) => (
            <div key={`${row.playerName}-${row.position}`} className="rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p>{row.position} - {row.playerName}</p>
                <p>{row.champion}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                {row.kills ?? 0}/{row.deaths ?? 0}/{row.assists ?? 0} | CS {row.cs ?? 0} | DPM {row.dpm ?? "-"}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{redTeamName}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {redRows.map((row) => (
            <div key={`${row.playerName}-${row.position}`} className="rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p>{row.position} - {row.playerName}</p>
                <p>{row.champion}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                {row.kills ?? 0}/{row.deaths ?? 0}/{row.assists ?? 0} | CS {row.cs ?? 0} | DPM {row.dpm ?? "-"}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}