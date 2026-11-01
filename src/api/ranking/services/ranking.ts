
import { factories } from '@strapi/strapi';
import { calculateBravePoints, computeLoserUpdate, computeRevert, computeWinnerUpdate, currentRankInfo, describeRankResult, getRankInfoFromPoints, nextRankInfo, RankResult } from '../utils/rankingMath';
import { notifyRankResults } from '../../../utils/realtime';

export default factories.createCoreService('api::ranking.ranking', ({ strapi }) => ({
    async getOrCreateCurrentSeason() {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth() + 1;
        const oddM = m % 2 === 0 ? m - 1 : m;
        const nextM = oddM + 1;
        const seasonName = `Season ${y} | ${String(oddM).padStart(2, '0')}-${String(nextM).padStart(2, '0')}`;

        let currentSeason = await strapi.db.query('api::season.season').findOne({
            where: { name: seasonName },
        }) as any;

        if (!currentSeason) {
            const startOfMonth = new Date(y, oddM - 1, 1);
            const endOfMonth = new Date(y, oddM + 1, 0);

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

    async recordMatch(winners: number[], losers: number[], winnerScore: number, loserScore: number, matchId: number, isRankingMode: boolean = false, options: { notify?: boolean } = {}) {
        const activeSeason = await this.getOrCreateCurrentSeason();

        const winnerRankings = await Promise.all(winners.map(id => this.getOrCreateRanking(id, activeSeason)));
        const loserRankings = await Promise.all(losers.map(id => this.getOrCreateRanking(id, activeSeason)));

        // Calculate average weights for difficulty adjustment (only if ranking mode)
        let weightDiff = 0;
        if (isRankingMode) {
            const avgWeightWinners = winnerRankings.reduce((sum, r) => sum + currentRankInfo(r as any, Number((r as any).ranking_points || 0)).weight, 0) / winnerRankings.length;
            const avgWeightLosers = loserRankings.reduce((sum, r) => sum + currentRankInfo(r as any, Number((r as any).ranking_points || 0)).weight, 0) / loserRankings.length;
            weightDiff = avgWeightLosers - avgWeightWinners;
        }

        const rankResults: { userId: number; data: RankResult }[] = [];

        // Record Winners
        await Promise.all(winnerRankings.map(async (ranking: any, index) => {
            const userId = winners[index];
            const oldRp = Number(ranking.ranking_points || 0);
            const oldBp = Number(ranking.brave_points || 0);

            const streakBefore = Number(ranking.win_streak || 0);
            const before = currentRankInfo(ranking, oldRp);
            const delta = computeWinnerUpdate({
                oldRp, oldBp, streakBefore, tier: before.tier, weightDiff, isRankingMode
            });
            const { newRp, newBp, rpChange: rpGain, bpChange } = delta;

            const rankInfo = nextRankInfo(ranking, oldRp, newRp, false);
            rankResults.push({ userId, data: describeRankResult({ matchId, isWin: true, delta, oldBp, before, after: rankInfo }) });
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
                    bp_change: bpChange,
                    win_streak_before: streakBefore,
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

            const oldRankInfo = currentRankInfo(ranking, oldRp);
            const streakBefore = Number(ranking.win_streak || 0);
            const delta = computeLoserUpdate({
                oldRp, oldBp, tier: oldRankInfo.tier, weightDiff, isRankingMode
            });
            const { newRp, newBp, rpChange, bpChange } = delta;

            const rankInfo = nextRankInfo(ranking, oldRp, newRp, true);
            rankResults.push({ userId, data: describeRankResult({ matchId, isWin: false, delta, oldBp, before: oldRankInfo, after: rankInfo }) });
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
                    rp_change: rpChange,
                    bp_change: bpChange,
                    win_streak_before: streakBefore,
                    is_win: false,
                    users: userId,
                    point_for: loserScore,
                    point_against: winnerScore
                }
            });
        }));

        // แจ้งผลดาว/แรงค์ให้ผู้เล่นแต่ละคน (เฉพาะโหมด ranking และเฉพาะแมตช์จริง — recalibrate ไม่ส่ง)
        if (isRankingMode && options.notify) notifyRankResults(rankResults);
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

            // streak ของแมตช์แพ้คืนได้เฉพาะเมื่อไม่มีแมตช์ใหม่กว่าบันทึกต่อจากนี้
            const newerCount = await strapi.db.query('api::match-history.match-history').count({
                where: { ranking: ranking.id, id: { $gt: history.id } }
            });
            const data = computeRevert({ ranking, history, isLatest: newerCount === 0 });
            // ถอยแมตช์ชนะ = RP ลดลง → แสดงผลขอบ division แบบเดียวกับตอนแพ้
            const rankInfo = nextRankInfo(ranking, Number(ranking.ranking_points || 0), data.ranking_points, history.is_win === true);

            await strapi.db.query('api::ranking.ranking').update({
                where: { id: ranking.id },
                data: {
                    ...data,
                    rank: rankInfo.rankStr,
                    stars: rankInfo.stars,
                    rank_tier: rankInfo.tier,
                    rank_division: rankInfo.divisionNum
                }
            });
        }

        // Delete the history records
        await strapi.db.query('api::match-history.match-history').deleteMany({
            where: { matches: matchId }
        });
    },

    getRankInfoFromPoints(points: number, options?: { isLoss?: boolean }) {
        return getRankInfoFromPoints(points, options);
    },

    calculateBravePoints(isWin: boolean, currentStreak: number = 0) {
        return calculateBravePoints(isWin, currentStreak);
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
