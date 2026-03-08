import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type BuildPathEntry = {
  minute: number;
  itemName: string;
  note?: string;
};

type BuildPathTimelineProps = {
  entries: BuildPathEntry[];
};

export function BuildPathTimeline({ entries }: BuildPathTimelineProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Build Path Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={`${entry.minute}-${entry.itemName}`}
              className="rounded-md border border-border/70 p-3"
            >
              <p className="text-sm font-medium text-foreground">
                {entry.minute}m - {entry.itemName}
              </p>
              {entry.note ? (
                <p className="text-xs text-muted-foreground">{entry.note}</p>
              ) : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
