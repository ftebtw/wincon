import { EmbedBuilder } from "discord.js";
function truncate(value, max = 1024) {
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, max - 3)}...`;
}
function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}
function formatGold(gold) {
    if (gold >= 1000) {
        return `${(gold / 1000).toFixed(1)}k`;
    }
    return String(gold);
}
export function buildAnalyzeEmbed(params) {
    const { player, match, analysis, matchUrl } = params;
    const startProb = match.winProbTimeline[0]?.winProbability ?? 0.5;
    const endProb = match.winProbTimeline[match.winProbTimeline.length - 1]?.winProbability ?? startProb;
    const keyMomentLines = (analysis.key_moments.length > 0
        ? analysis.key_moments.slice(0, 4).map((moment) => {
            const marker = moment.type === "good_play" ? "+" : "-";
            const delta = moment.win_prob_impact >= 0 ? `+${moment.win_prob_impact}%` : `${moment.win_prob_impact}%`;
            return `${marker} ${moment.timestamp} - ${moment.title} (${delta})`;
        })
        : match.keyMoments.slice(0, 4).map((moment) => {
            const marker = moment.type === "positive" ? "+" : "-";
            const deltaPercent = Math.round(moment.totalDelta * 100);
            const delta = deltaPercent >= 0 ? `+${deltaPercent}%` : `${deltaPercent}%`;
            return `${marker} ${formatDuration(Math.floor(moment.timestamp / 1000))} - ${moment.description} (${delta})`;
        })).join("\n");
    const improvements = analysis.top_3_improvements
        .slice(0, 3)
        .map((item, index) => `${index + 1}. ${item}`)
        .join("\n");
    const kda = `${match.player.kills}/${match.player.deaths}/${match.player.assists}`;
    const rank = player.rankedStats.find((entry) => entry.queueType === "RANKED_SOLO_5x5");
    return new EmbedBuilder()
        .setColor(match.player.win ? 0x10b981 : 0xef4444)
        .setTitle(`Match Analysis - ${match.player.champion} (${match.player.role}) [${analysis.overall_grade}]`)
        .setDescription(`${match.player.win ? "WIN" : "LOSS"} - ${kda} - ${formatDuration(match.match.gameDuration)}\n` +
        `${player.player.gameName}#${player.player.tagLine}${rank ? ` - ${rank.tier} ${rank.rank}` : ""}`)
        .addFields({
        name: "Win Probability",
        value: `${formatPercent(startProb)} -> ${formatPercent(endProb)}`,
        inline: false,
    }, {
        name: "Key Moments",
        value: truncate(keyMomentLines || "No major swing moments detected."),
        inline: false,
    }, {
        name: `Build: ${analysis.build_analysis.rating.toUpperCase()}`,
        value: truncate(analysis.build_analysis.explanation),
        inline: false,
    }, {
        name: "Top 3 Improvements",
        value: truncate(improvements || "No action items generated."),
        inline: false,
    })
        .setURL(matchUrl)
        .setFooter({ text: "WinCon.gg | Full analysis on web" });
}
export function buildScoutEmbed(params) {
    const { riotId, liveGame, scoutUrl } = params;
    const reminders = liveGame.aiScout.three_things_to_remember
        .slice(0, 3)
        .map((line, index) => `${index + 1}. ${line}`)
        .join("\n");
    const laneMatchup = liveGame.aiScout.lane_matchup;
    const itemLine = liveGame.recommendedBuild.items
        .slice(0, 3)
        .map((item) => item.itemName)
        .join(" -> ");
    return new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`Loading Screen Scout - ${riotId}`)
        .addFields({
        name: "3 Things to Remember",
        value: truncate(reminders || "No reminders available."),
    }, {
        name: `Lane Matchup: ${liveGame.player.championName} vs ${liveGame.laneOpponent.championName} [${laneMatchup.difficulty.toUpperCase()}]`,
        value: truncate(`They want: ${laneMatchup.their_win_condition}\n` +
            `You want: ${laneMatchup.your_win_condition}`),
    }, {
        name: "Recommended Build",
        value: truncate(`${itemLine || "No item path available."}\n${liveGame.recommendedBuild.reasoning}`),
    })
        .setURL(scoutUrl)
        .setFooter({ text: "WinCon.gg | Full scout on web" });
}
export function buildProfileEmbed(params) {
    const { riotId, player, profileUrl, patternLine } = params;
    const solo = player.rankedStats.find((entry) => entry.queueType === "RANKED_SOLO_5x5");
    const rankLine = solo
        ? `Rank: ${solo.tier} ${solo.rank} - ${solo.leaguePoints} LP\nRecord: ${solo.wins}W / ${solo.losses}L (${((solo.wins / Math.max(1, solo.wins + solo.losses)) * 100).toFixed(1)}% WR)`
        : "Unranked in Solo Queue";
    const championStats = new Map();
    for (const match of player.recentMatches) {
        const current = championStats.get(match.champion) ?? { games: 0, wins: 0 };
        current.games += 1;
        if (match.win) {
            current.wins += 1;
        }
        championStats.set(match.champion, current);
    }
    const topChampions = [...championStats.entries()]
        .sort((a, b) => b[1].games - a[1].games)
        .slice(0, 3)
        .map(([champion, stats]) => {
        const wr = (stats.wins / Math.max(1, stats.games)) * 100;
        return `${champion} (${stats.games} games, ${wr.toFixed(0)}% WR)`;
    })
        .join("\n");
    return new EmbedBuilder()
        .setColor(0x1f2937)
        .setTitle(`${riotId} - Level ${player.player.summonerLevel}`)
        .setDescription(rankLine)
        .addFields({
        name: "Most Played",
        value: truncate(topChampions || "Not enough recent matches."),
    }, {
        name: "Pattern",
        value: truncate(patternLine),
    })
        .setURL(profileUrl)
        .setFooter({ text: "WinCon.gg | Full profile on web" });
}
export function buildProgressEmbed(params) {
    const { riotId, progress, progressUrl } = params;
    const trendLookup = new Map(progress.trends.map((trend) => [trend.metric, trend]));
    const trendLine = (metric, label, format) => {
        const trend = trendLookup.get(metric);
        if (!trend) {
            return `- ${label}: n/a`;
        }
        const marker = trend.direction === "improved" ? "+" : trend.direction === "declined" ? "-" : "=";
        return `${marker} ${label}: ${format(trend.previous)} -> ${format(trend.current)} (${trend.changePercent >= 0 ? "+" : ""}${trend.changePercent.toFixed(1)}%)`;
    };
    return new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`Weekly Progress - ${riotId}`)
        .setDescription(`Improvement Score: ${progress.improvementScore}/100\n` +
        `This Week: ${progress.current.wins}W ${progress.current.losses}L (${formatPercent(progress.current.winRate)})`)
        .addFields({
        name: "Trend Highlights",
        value: truncate([
            trendLine("vision_score", "Vision Score", (value) => value.toFixed(1)),
            trendLine("cs_per_min", "CS/min", (value) => value.toFixed(2)),
            trendLine("deaths_before_10", "Early Deaths", (value) => value.toFixed(2)),
            trendLine("kda", "KDA", (value) => value.toFixed(2)),
            trendLine("damage_share", "Damage Share", (value) => `${(value * 100).toFixed(1)}%`),
        ].join("\n")),
    }, {
        name: "Rank Prediction",
        value: truncate(`${progress.rankPrediction.currentRank} -> ${progress.rankPrediction.predictedRank}\n` +
            `ETA: ${progress.rankPrediction.gamesNeeded >= 999 ? "Unknown (negative LP trajectory)" : `${progress.rankPrediction.gamesNeeded} games`}`),
    })
        .setURL(progressUrl)
        .setFooter({ text: "WinCon.gg | Full progress report on web" });
}
export function buildBuildEmbed(params) {
    const { champion, role, enemies, build, buildUrl } = params;
    const core = build.recommendation.coreItems.slice(0, 3).map((item) => item.itemName).join(" -> ");
    const situational = build.recommendation.situationalItems
        .slice(0, 2)
        .map((item) => `${item.itemName} (${item.when})`)
        .join("\n");
    return new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`${champion} ${role.toUpperCase()} - Optimal Build`)
        .setDescription(`Enemy comp tags: ${build.compAnalysis.enemy.tags.join(", ") || "Unknown"}\n` +
        `Enemy lineup: ${enemies.join(", ") || "default"}`)
        .addFields({ name: "Core", value: truncate(core || "No core path available.") }, {
        name: "Boots",
        value: `${build.recommendation.boots.itemName}\n${truncate(build.recommendation.boots.reasoning, 200)}`,
    }, {
        name: "Situational",
        value: truncate(situational || "No situational swaps recommended."),
    }, {
        name: "Why",
        value: truncate(build.recommendation.overallStrategy),
    })
        .setURL(buildUrl)
        .setFooter({ text: "WinCon.gg | Full build analysis on web" });
}
export function buildLiveProEmbed(params) {
    const { live, proUrl } = params;
    if (!live.isLive || !live.events || live.events.length === 0) {
        const next = live.upcoming?.[0];
        const nextLine = next
            ? `${next.match?.teams?.[0]?.name ?? "TBD"} vs ${next.match?.teams?.[1]?.name ?? "TBD"}`
            : "No upcoming match available";
        return new EmbedBuilder()
            .setColor(0x1f2937)
            .setTitle("Live Pro Games")
            .setDescription(`No pro games currently live.\nNext match: ${nextLine}`)
            .setURL(proUrl)
            .setFooter({ text: "WinCon.gg | Pro Section" });
    }
    const lines = live.events.slice(0, 3).map((event) => {
        const teams = event.match?.teams ?? [];
        const left = teams[0];
        const right = teams[1];
        const score = `${left?.result?.gameWins ?? 0}-${right?.result?.gameWins ?? 0}`;
        const game = live.games?.find((entry) => entry.eventId === event.id);
        if (!game) {
            return `${event.league.slug.toUpperCase()}: ${left?.code ?? left?.name ?? "TBD"} ${score} ${right?.code ?? right?.name ?? "TBD"} (live)`;
        }
        return (`${event.league.slug.toUpperCase()}: ${left?.code ?? left?.name ?? "TBD"} ${score} ${right?.code ?? right?.name ?? "TBD"} ` +
            `(Game ${game.number}, ${formatDuration(game.clock.totalSeconds)})\n` +
            `${game.teams[0]?.code ?? "BLUE"}: ${game.teams[0]?.kills ?? 0}K, ${formatGold(game.teams[0]?.gold ?? 0)} gold | ` +
            `${game.teams[1]?.code ?? "RED"}: ${game.teams[1]?.kills ?? 0}K, ${formatGold(game.teams[1]?.gold ?? 0)} gold`);
    });
    return new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle("Live Pro Games")
        .setDescription(lines.join("\n\n"))
        .addFields({
        name: "Links",
        value: "[Watch on lolesports.com](https://lolesports.com/en-US/schedule)\n" +
            `[Open WinCon Pro Section](${proUrl})`,
    })
        .setURL(proUrl)
        .setFooter({ text: "WinCon.gg | Live updates every 30s" });
}
