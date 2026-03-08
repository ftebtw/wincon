import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function MatchLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex gap-2">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-20" />
          </div>
          <Skeleton className="h-8 w-72" />
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={`blue-${index}`} className="flex items-center gap-2 rounded-md border border-border/60 p-2">
                <Skeleton className="size-10 rounded-full" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={`red-${index}`} className="flex items-center gap-2 rounded-md border border-border/60 p-2">
                <Skeleton className="size-10 rounded-full" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-7 w-52" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] w-full md:h-[320px]" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-2 w-11/12 rounded-full" />
            <Skeleton className="h-2 w-10/12 rounded-full" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-7 w-36" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-32 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
