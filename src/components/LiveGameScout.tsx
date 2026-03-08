import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type LiveGameScoutPlayer = {
  summonerName: string;
  championName: string;
  teamId: number;
};

type LiveGameScoutProps = {
  players: LiveGameScoutPlayer[];
};

export function LiveGameScout({ players }: LiveGameScoutProps) {
  const grouped = players.reduce<Record<number, LiveGameScoutPlayer[]>>(
    (acc, player) => {
      if (!acc[player.teamId]) {
        acc[player.teamId] = [];
      }

      acc[player.teamId].push(player);
      return acc;
    },
    {},
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live Game Scout</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        {Object.entries(grouped).map(([teamId, teamPlayers]) => (
          <div key={teamId} className="rounded-md border border-border/70 p-3">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Team {teamId}</h3>
            <div className="space-y-2">
              {teamPlayers.map((player) => (
                <p key={`${player.summonerName}-${player.championName}`} className="text-sm">
                  <span className="text-foreground">{player.summonerName}</span>{" "}
                  <span className="text-muted-foreground">on {player.championName}</span>
                </p>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
