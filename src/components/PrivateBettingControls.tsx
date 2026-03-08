"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

interface PrivateBettingControlsProps {
  initialDryRun: boolean;
}

export function PrivateBettingControls({ initialDryRun }: PrivateBettingControlsProps) {
  const [dryRun, setDryRun] = useState(initialDryRun);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const runScan = async () => {
    setLoading(true);
    setMessage(null);

    const response = await fetch("/api/private/betting/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const payload = (await response.json().catch(() => ({}))) as {
      reason?: string;
      opportunities?: unknown[];
      betsPlaced?: number;
      error?: string;
    };

    if (!response.ok) {
      setMessage(payload.error ?? "Scan failed.");
      setLoading(false);
      return;
    }

    setMessage(
      `Scan complete: ${payload.opportunities?.length ?? 0} opportunities, ${payload.betsPlaced ?? 0} bets placed (${payload.reason ?? "ok"}).`,
    );
    setLoading(false);
  };

  const logout = async () => {
    await fetch("/api/private/auth", { method: "DELETE" });
    window.location.href = "/private/login";
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={() => setDryRun((value) => !value)}>
        Auto-bet: {dryRun ? "Dry Run" : "Live"}
      </Button>
      <Button onClick={runScan} disabled={loading}>
        {loading ? "Scanning..." : "Run Scan Now"}
      </Button>
      <Button variant="ghost" onClick={logout}>
        Sign Out
      </Button>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}

