
import { factories } from '@strapi/strapi';

const BRAVE_POINTS_CAP = 100;

export default factories.createCoreService('api::ranking.ranking', ({ strapi }) => ({
    async getOrCreateCurrentSeason() {
        const now = new Date();
        const monthStr = now.toISOString().slice(0, 7);
        const seasonName = `Season ${monthStr}`;

        let currentSeason = await strapi.db.query('api::season.season').findOne({
            where: { name: seasonName },
        }) as any;

        if (!currentSeason) {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

            // Deactivate ALL other active seasons before creating the new one
            await strapi.db.query('api::season.season').updateMany({
                where: { is_active: true },
                data: { is_active: false },
            });
            console.log(`[Season] Deactivated all previous active seasons.`);

            currentSeason = await strapi.db.query('api::season.season').create({
                data: {
                    name: seasonName,
                    is_active: true,
                    start_date: startOfMonth.toISOString().split('T')[0],
                    end_date: endOfMonth.toISOString().split('T')[0]
                },
            });
            console.log(`[Season] Created new season: ${seasonName}`);
        } else if (!currentSeason.is_active) {
            // Re-activating current month's season — deactivate others first
            await strapi.db.query('api::season.season').updateMany({
                where: { is_active: true, id: { $ne: currentSeason.id } },
                data: { is_active: false },
            });
            await strapi.db.query('api::season.season').update({
                where: { id: currentSeason.id },
                data: { is_active: true }
            });
            console.log(`[Season] Re-activated season: ${seasonName}, deactivated others.`);
        } else {
            // Current season already active — still ensure no other season is also active
            const deactivated = await strapi.db.query('api::season.season').updateMany({
                where: { is_active: true, id: { $ne: currentSeason.id } },
                data: { is_active: false },
            });
            if ((deactivated as any)?.count > 0) {
                console.log(`[Season] Cleaned up ${(deactivated as any).count} stale active season(s).`);
            }
        }

        return currentSeason;
    },

    async getOrCreateRanking(userId: any, activeSeason: any) {
        // Use db.query for maximum stability with IDs
        let ranking = await strapi.db.query('api::ranking.ranking').findOne({
            where: {
                user_id: userId,
                season: activeSeason.id
            },
        }) as any;

        if (!ranking) {
            const { rankStr, stars, tier, divisionNum } = this.getRankInfoFromPoints(0);

            ranking = await strapi.db.query('api::ranking.ranking').create({
                data: {
                    user_id: userId,
                    season: activeSeason.id,
                    ranking_points: 0,
                    brave_points: 0,
                    rank: rankStr,
                    stars: stars,
                    rank_tier: tier,
                    rank_division: divisionNum,
                    match_played: 0,
                    win: 0,
                    lose: 0,
                    win_streak: 0,
                    point_for: 0,
                    point_against: 0
                },
            });
        }
        return ranking;
    },

    async recordMatch(winners: number[], losers: number[], winnerScore: number, loserScore: number, matchId: number, isRankingMode: boolean = false) {
        const activeSeason = await this.getOrCreateCurrentSeason();

        const winnerRankings = await Promise.all(winners.map(id => this.getOrCreateRanking(id, activeSeason)));
        const loserRankings = await Promise.all(losers.map(id => this.getOrCreateRanking(id, activeSeason)));

        // Calculate average weights for difficulty adjustment (only if ranking mode)
        let weightDiff = 0;
        if (isRankingMode) {
            const avgWeightWinners = winnerRankings.reduce((sum, r) => sum + this.getRankInfoFromPoints((r as any).ranking_points).weight, 0) / winnerRankings.length;
            const avgWeightLosers = loserRankings.reduce((sum, r) => sum + this.getRankInfoFromPoints((r as any).ranking_points).weight, 0) / loserRankings.length;
            weightDiff = avgWeightLosers - avgWeightWinners;
        }

        // Record Winners
        await Promise.all(winnerRankings.map(async (ranking: any, index) => {
            const userId = winners[index];
            const oldRp = Number(ranking.ranking_points || 0);
            const oldBp = Number(ranking.brave_points || 0);

            let newRp = oldRp;
            let newBp = oldBp;
            let rpGain = 0;

            if (isRankingMode) {
                let bpGain = this.calculateBravePoints(true);
                if (weightDiff > 200) bpGain += Math.floor(weightDiff / 20);

                newBp = oldBp + bpGain;
                rpGain = 100;

                if (newBp >= BRAVE_POINTS_CAP) {
                    rpGain += 100;
                    newBp -= BRAVE_POINTS_CAP;
                }
                newRp = oldRp + rpGain;
            }

            const rankInfo = this.getRankInfoFromPoints(newRp);
            console.log(`[Ranking Service] Updating Winner ${userId}: ${oldRp} -> ${newRp} RP, Rank: ${rankInfo.rankStr}, Stars: ${rankInfo.stars}`);

            await strapi.db.query('api::ranking.ranking').update({
                where: { id: ranking.id },
                data: {
                    ranking_points: newRp,
                    brave_points: newBp,
                    rank: rankInfo.rankStr,
                    stars: rankInfo.stars,
                    rank_tier: rankInfo.tier,
                    rank_division: rankInfo.divisionNum,
                    match_played: (ranking.match_played || 0) + 1,
                    win: (ranking.win || 0) + 1,
                    win_streak: (ranking.win_streak || 0) + 1,
                    point_for: (ranking.point_for || 0) + winnerScore,
                    point_against: (ranking.point_against || 0) + loserScore
                }
            });

            await strapi.db.query('api::match-history.match-history').create({
                data: {
                    ranking: ranking.id,
                    matches: matchId, // Using numeric id here
                    old_rp: oldRp,
                    new_rp: newRp,
                    rp_change: rpGain,
                    is_win: true,
                    users: userId,
                    point_for: winnerScore,
                    point_against: loserScore
                }
            });
        }));

        // Record Losers
        await Promise.all(loserRankings.map(async (ranking: any, index) => {
            const userId = losers[index];
            const oldRp = Number(ranking.ranking_points || 0);
            const oldBp = Number(ranking.brave_points || 0);

            const oldRankInfo = this.getRankInfoFromPoints(oldRp);
            let newRp = oldRp;
            let newBp = oldBp;
            let rpLoss = 0;

            if (isRankingMode) {
                let bpGain = this.calculateBravePoints(false);
                if (weightDiff < -500) bpGain += 10;

                newBp = oldBp + bpGain;

                // Bronze Protection: No star loss in Bronze rank
                if (oldRankInfo.tier === 'Bronze') {
                    rpLoss = 0;
                } else {
                    rpLoss = 100;
                    // General Protection: Use Brave Points if full
                    if (newBp >= BRAVE_POINTS_CAP) {
                        rpLoss = 0;
                        newBp -= BRAVE_POINTS_CAP;
                    }
                }
                newRp = Math.max(0, oldRp - rpLoss);
            }

            const rankInfo = this.getRankInfoFromPoints(newRp);
            console.log(`[Ranking Service] Updating Loser ${userId}: ${oldRp} -> ${newRp} RP, Rank: ${rankInfo.rankStr}, Stars: ${rankInfo.stars}`);

            await strapi.db.query('api::ranking.ranking').update({
                where: { id: ranking.id },
                data: {
                    ranking_points: newRp,
                    brave_points: newBp,
                    rank: rankInfo.rankStr,
                    stars: rankInfo.stars,
                    rank_tier: rankInfo.tier,
                    rank_division: rankInfo.divisionNum,
                    match_played: (ranking.match_played || 0) + 1,
                    lose: (ranking.lose || 0) + 1,
                    win_streak: 0,
                    point_for: (ranking.point_for || 0) + loserScore,
                    point_against: (ranking.point_against || 0) + winnerScore
                }
            });

            await strapi.db.query('api::match-history.match-history').create({
                data: {
                    ranking: ranking.id,
                    matches: matchId, // Using numeric id here
                    old_rp: oldRp,
                    new_rp: newRp,
                    rp_change: -rpLoss,
                    is_win: false,
                    users: userId,
                    point_for: loserScore,
                    point_against: winnerScore
                }
            });
        }));
    },

    async revertMatch(matchId: number) {
        // Find all history for this match (using numeric ID for the link table)
        const histories = await strapi.db.query('api::match-history.match-history').findMany({
            where: { matches: matchId },
            populate: ['ranking']
        });

        if (histories.length === 0) return;

        console.log(`[Ranking Service] Reverting ${histories.length} history records for match ${matchId}...`);

        for (const history of histories) {
            const ranking = history.ranking;
            if (!ranking) continue;

            const rpChange = Number(history.rp_change || 0);
            const isWin = history.is_win;
            const pFor = Number(history.point_for || 0);
            const pAgainst = Number(history.point_against || 0);

            const newRp = Math.max(0, (ranking.ranking_points || 0) - rpChange);
            const rankInfo = this.getRankInfoFromPoints(newRp);

            await strapi.db.query('api::ranking.ranking').update({
                where: { id: ranking.id },
                data: {
                    ranking_points: newRp,
                    rank: rankInfo.rankStr,
                    stars: rankInfo.stars,
                    rank_tier: rankInfo.tier,
                    rank_division: rankInfo.divisionNum,
                    match_played: Math.max(0, (ranking.match_played || 0) - 1),
                    win: isWin ? Math.max(0, (ranking.win || 0) - 1) : ranking.win,
                    lose: !isWin ? Math.max(0, (ranking.lose || 0) - 1) : ranking.lose,
                    point_for: Math.max(0, (ranking.point_for || 0) - pFor),
                    point_against: Math.max(0, (ranking.point_against || 0) - pAgainst)
                }
            });
        }

        // Delete the history records
        await strapi.db.query('api::match-history.match-history').deleteMany({
            where: { matches: matchId }
        });
    },

    // Simplified points to rank logic
    getRankInfoFromPoints(points: number) {
        const TIERS = [
            { name: 'Bronze', divisions: 3, starsPerDiv: 3 },
            { name: 'Silver', divisions: 3, starsPerDiv: 4 },
            { name: 'Gold', divisions: 4, starsPerDiv: 4 },
            { name: 'Platinum', divisions: 5, starsPerDiv: 5 },
            { name: 'Diamond', divisions: 5, starsPerDiv: 5 },
            { name: 'Master', divisions: 1, starsPerDiv: 99999 }
        ];
        const DIVS = ['V', 'IV', 'III', 'II', 'I'];

        let p = points;
        for (const t of TIERS) {
            const tierMax = t.divisions * t.starsPerDiv * 100;
            if (p < tierMax || t.name === 'Master') {
                if (t.name === 'Master') {
                    const s = Math.floor(p / 100);
                    return { tier: 'Master', division: '', divisionNum: 1, stars: s, rankStr: 'Master', weight: 6000 + (s * 10) };
                }
                const divIdx = Math.floor(p / (t.starsPerDiv * 100));
                const stars = Math.floor((p % (t.starsPerDiv * 100)) / 100);
                const activeDivs = DIVS.slice(5 - t.divisions);
                const divisionStr = activeDivs[divIdx];
                return {
                    tier: t.name,
                    division: divisionStr,
                    divisionNum: t.divisions - divIdx,
                    stars: stars,
                    rankStr: `${t.name} ${divisionStr}`,
                    weight: 1000 + (TIERS.indexOf(t) * 1000) + (divIdx * 200) + (stars * 50)
                };
            }
            p -= tierMax;
        }
        return { tier: 'Bronze', division: 'III', divisionNum: 3, stars: 0, rankStr: 'Bronze III', weight: 1000 };
    },

    calculateBravePoints(isWin: boolean) {
        return isWin ? 20 : 10;
    },

    async recalibrateSeason() {
        const activeSeason = await this.getOrCreateCurrentSeason();

        // Filter matches within the active season's date range
        const matches = await strapi.db.query('api::match.match').findMany({
            where: {
                match_status: 'done',
                createdAt: {
                    $gte: activeSeason.start_date + "T00:00:00.000Z",
                    $lte: activeSeason.end_date + "T23:59:59.999Z"
                }
            },
            orderBy: { createdAt: 'asc' },
            populate: ['tournament_id', 'team_a_id.team_players.user_id', 'team_b_id.team_players.user_id']
        });

        console.log(`[Recalibrate] Resetting and re-processing ${matches.length} matches for ${activeSeason.name}...`);

        // 1. Find all ranking IDs for this season
        const rankingsToReset = await strapi.db.query('api::ranking.ranking').findMany({
            where: { season: activeSeason.id },
            select: ['id']
        });
        const rankingIds = rankingsToReset.map(r => r.id);

        if (rankingIds.length > 0) {
            // 2. Delete match history ONLY for these rankings
            await strapi.db.query('api::match-history.match-history').deleteMany({
                where: { ranking: { id: { $in: rankingIds } } }
            });

            // 3. Reset the rankings themselves
            await strapi.db.query('api::ranking.ranking').deleteMany({
                where: { id: { $in: rankingIds } }
            });
        }

        // 4. Re-process matches for the current season
        for (const m of matches) {
            const scoreA = m.score_a || 0;
            const scoreB = m.score_b || 0;
            if (scoreA === scoreB) continue;

            const isWinnerA = scoreA > scoreB;
            const winnerTeam = isWinnerA ? m.team_a_id : m.team_b_id;
            const loserTeam = isWinnerA ? m.team_b_id : m.team_a_id;

            const winners = winnerTeam.team_players?.map(tp => tp.user_id?.id).filter(Boolean);
            const losers = loserTeam.team_players?.map(tp => tp.user_id?.id).filter(Boolean);

            if (winners?.length > 0 && losers?.length > 0) {
                const isRankingMode = m.tournament_id?.mode === 'ranking';
                await this.recordMatch(winners, losers, isWinnerA ? scoreA : scoreB, isWinnerA ? scoreB : scoreA, m.id, isRankingMode);
            }
        }
        return { count: matches.length, season: activeSeason.name };
    }
}));
