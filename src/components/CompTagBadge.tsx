import { Badge } from "@/components/ui/badge";

import type { CompTag } from "@/lib/comp-classifier";

type CompTagBadgeProps = {
  tag: CompTag;
};

const STYLE_MAP: Record<CompTag, string> = {
  high_ap: "border-purple-400/40 bg-purple-500/15 text-purple-200",
  high_ad: "border-orange-400/40 bg-orange-500/15 text-orange-200",
  mixed_damage: "border-cyan-400/40 bg-cyan-500/15 text-cyan-200",
  assassin_heavy: "border-red-400/40 bg-red-500/15 text-red-200",
  tank_heavy: "border-slate-400/40 bg-slate-500/15 text-slate-100",
  bruiser_heavy: "border-amber-400/40 bg-amber-500/15 text-amber-200",
  poke_comp: "border-indigo-400/40 bg-indigo-500/15 text-indigo-200",
  engage_comp: "border-blue-400/40 bg-blue-500/15 text-blue-200",
  split_push: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200",
  scaling_comp: "border-violet-400/40 bg-violet-500/15 text-violet-200",
  early_game: "border-yellow-400/40 bg-yellow-500/15 text-yellow-200",
  healing_heavy: "border-green-400/40 bg-green-500/15 text-green-200",
  cc_heavy: "border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-200",
  peel_heavy: "border-sky-400/40 bg-sky-500/15 text-sky-200",
  dive_comp: "border-rose-400/40 bg-rose-500/15 text-rose-200",
};

const LABELS: Record<CompTag, string> = {
  high_ap: "High AP",
  high_ad: "High AD",
  mixed_damage: "Mixed Damage",
  assassin_heavy: "Assassin Heavy",
  tank_heavy: "Tank Heavy",
  bruiser_heavy: "Bruiser Heavy",
  poke_comp: "Poke Comp",
  engage_comp: "Engage Comp",
  split_push: "Split Push",
  scaling_comp: "Scaling Comp",
  early_game: "Early Game",
  healing_heavy: "Healing Heavy",
  cc_heavy: "CC Heavy",
  peel_heavy: "Peel Heavy",
  dive_comp: "Dive Comp",
};

export function CompTagBadge({ tag }: CompTagBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={`border ${STYLE_MAP[tag]} font-medium tracking-wide`}
    >
      {LABELS[tag]}
    </Badge>
  );
}
