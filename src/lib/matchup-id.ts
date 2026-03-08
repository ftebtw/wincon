export type MatchupIdParts = {
  champion: string;
  role: string;
  enemy: string;
  enemyRole: string;
};

export function normalizeMatchupRole(value: string): string {
  const normalized = value.toUpperCase();
  if (normalized === "SUP") return "SUPPORT";
  if (normalized === "JG") return "JUNGLE";
  return normalized;
}

export function normalizeChampionLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseMatchupId(matchupId: string): MatchupIdParts | null {
  const decoded = decodeURIComponent(matchupId).trim();
  const [left, right] = decoded.split("-vs-");
  if (!left || !right) {
    return null;
  }

  const leftSplit = left.lastIndexOf("-");
  const rightSplit = right.lastIndexOf("-");
  if (leftSplit <= 0 || rightSplit <= 0) {
    return null;
  }

  const champion = left.slice(0, leftSplit).trim();
  const role = normalizeMatchupRole(left.slice(leftSplit + 1).trim());
  const enemy = right.slice(0, rightSplit).trim();
  const enemyRole = normalizeMatchupRole(right.slice(rightSplit + 1).trim());

  if (!champion || !enemy || !role || !enemyRole) {
    return null;
  }

  return { champion, role, enemy, enemyRole };
}
