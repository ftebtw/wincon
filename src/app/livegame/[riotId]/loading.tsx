import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function LiveGameLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-8">
      <Card>
        <CardHeader>
          <Skeleton className="h-8 w-64" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-6 w-72" />
          <Skeleton className="h-6 w-80" />
          <Skeleton className="h-6 w-64" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-7 w-52" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-7 w-48" />
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
