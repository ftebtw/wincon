"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { REGION_CONFIG, REGION_ORDER, type Region } from "@/lib/regions";

type RegionSelectorProps = {
  initialRegion: Region;
};

export function RegionSelector({ initialRegion }: RegionSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const activeRegion =
    (searchParams.get("region")?.toUpperCase() as Region | null) ?? initialRegion;

  const changeRegion = (region: Region) => {
    startTransition(async () => {
      await fetch("/api/region", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ region }),
      });

      const params = new URLSearchParams(searchParams.toString());
      params.set("region", region);
      router.replace(`${pathname}?${params.toString()}`);
      router.refresh();
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="justify-self-end" disabled={isPending}>
          {activeRegion}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {REGION_ORDER.map((region) => (
          <DropdownMenuItem key={region} onSelect={() => changeRegion(region)}>
            {region} - {REGION_CONFIG[region].displayName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
