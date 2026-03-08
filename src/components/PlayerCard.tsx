import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type PlayerCardProps = {
  riotId: string;
  rank?: string;
  winRate?: number;
};

export function PlayerCard({
  riotId,
  rank = "Unranked",
  winRate = 0,
}: PlayerCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{riotId}</CardTitle>
        <Badge variant="secondary">{rank}</Badge>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Estimated win rate: <span className="text-foreground">{winRate}%</span>
      </CardContent>
    </Card>
  );
}
