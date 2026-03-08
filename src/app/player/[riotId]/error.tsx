"use client";

import { useEffect } from "react";

import { ErrorCard } from "@/components/ErrorCard";

type PlayerErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function PlayerError({ error, reset }: PlayerErrorProps) {
  useEffect(() => {
    console.error("[PlayerPage] Render error:", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <ErrorCard
        title="Unable To Load Profile"
        description="Something went wrong. Please try refreshing."
        onRetry={reset}
      />
    </div>
  );
}
