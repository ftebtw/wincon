"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const DEFAULT_PLACEHOLDER = "Enter Riot ID (e.g., Player#NA1)";

type SearchBarProps = {
  className?: string;
  placeholder?: string;
  buttonLabel?: string;
  compact?: boolean;
};

function buildPlayerRoute(riotId: string): string | null {
  const normalizedInput = riotId.trim();
  const separatorIndex = normalizedInput.lastIndexOf("#");

  if (separatorIndex <= 0 || separatorIndex === normalizedInput.length - 1) {
    return null;
  }

  const gameName = normalizedInput.slice(0, separatorIndex).trim();
  const tagLine = normalizedInput.slice(separatorIndex + 1).trim();

  if (!gameName || !tagLine) {
    return null;
  }

  return `/player/${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`;
}

export function SearchBar({
  className,
  placeholder = DEFAULT_PLACEHOLDER,
  buttonLabel = "Analyze",
  compact = false,
}: SearchBarProps) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const route = buildPlayerRoute(value);

    if (!route) {
      setError("Use Riot ID format: gameName#tagLine");
      return;
    }

    setError(null);
    router.push(route);
  };

  return (
    <div className={cn("w-full", className)}>
      <form
        onSubmit={handleSubmit}
        className="flex w-full items-center gap-2"
        aria-label="Search by Riot ID"
      >
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className={cn("h-11", compact && "h-10")}
          placeholder={placeholder}
          aria-label="Riot ID"
        />
        <Button type="submit" className={cn("h-11 px-5", compact && "h-10 px-3")}>
          <Search className="size-4" />
          <span className={cn(compact && "sr-only")}>{buttonLabel}</span>
        </Button>
      </form>
      {!compact && error ? (
        <p className="mt-2 text-left text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
