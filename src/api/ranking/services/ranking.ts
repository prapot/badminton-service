import { factories } from '@strapi/strapi';

const TIERS = [
    { name: 'Bronze', divisions: 5, starsPerDiv: 3, weight: 1 },
    { name: 'Silver', divisions: 5, starsPerDiv: 3, weight: 2 },
    { name: 'Gold', divisions: 5, starsPerDiv: 4, weight: 3 },
    { name: 'Platinum', divisions: 5, starsPerDiv: 5, weight: 4 },
    { name: 'Diamond', divisions: 5, starsPerDiv: 5, weight: 5 },
    { name: 'Master', divisions: 1, starsPerDiv: 999999, weight: 6 }
];

const DIVISIONS = ['V', 'IV', 'III', 'II', 'I'];
const BRAVE_POINTS_CAP = 100;

export default factories.createCoreService('api::ranking.ranking', ({ strapi }) => ({
    async getOrCreateCurrentSeason() {
        const now = new Date();
        const monthStr = now.toISOString().slice(0, 7);
        const seasonName = `Season ${monthStr}`;

        let currentSeason = await strapi.documents('api::season.season').findFirst({
            filters: { name: seasonName },
            status: 'published'
        });

        if (!currentSeason) {
            console.log(`[Cron/Service] Transitioning to new season: ${seasonName}`);
            const activeSeasons = await strapi.documents('api::season.season').findMany({
                filters: { is_active: true }
            });
            for (const s of activeSeasons) {
                await strapi.documents('api::season.season').update({
                    documentId: s.documentId,
                    data: { is_active: false },
                    status: 'published'
                });
            }

            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

            currentSeason = await strapi.documents('api::season.season').create({
                data: {
                    name: seasonName,
                    is_active: true,
                    start_date: startOfMonth.toISOString().split('T')[0],
                    end_date: endOfMonth.toISOString().split('T')[0]
                },
                status: 'published'
            });
        }
        return currentSeason;
    },

    calculateBravePoints(isWin: boolean, winnerScore: number, loserScore: number, winStreak: number) {
        let points = 0;
        const scoreDiff = Math.abs(winnerScore - loserScore);
        if (isWin) {
            points += 15; // Base win
            if (winStreak >= 3) points += 10;
            if (scoreDiff >= 10) points += 5;
        } else {
            if (scoreDiff <= 2) points += 10;
        }
        return points;
    },

    getRankInfoFromPoints(points: number) {
        let p = Math.max(0, points);
        for (const tier of TIERS) {
            if (tier.name === 'Master') {
                return {
                    tier: 'Master',
                    division: '',
                    stars: Math.floor(p / 100),
                    rankStr: 'Master',
                    weight: tier.weight
                };
            }
            const tierMax = tier.divisions * tier.starsPerDiv * 100;
            if (p < tierMax) {
                const divIdx = Math.floor(p / (tier.starsPerDiv * 100));
                const divStars = Math.floor((p % (tier.starsPerDiv * 100)) / 100);
                const rankStr = `${tier.name} ${DIVISIONS[divIdx]}`;
                return {
                    tier: tier.name,
                    division: DIVISIONS[divIdx],
                    stars: divStars,
                    rankStr: rankStr,
                    weight: tier.weight
                };
            }
            p -= tierMax;
        }
        return { tier: 'Bronze', division: 'V', stars: 0, rankStr: 'Bronze V', weight: 1 };
    },

    calculateSoftReset(oldPoints: number) {
        const { tier } = this.getRankInfoFromPoints(oldPoints);
        let resetPoints = 0;

        // Reset points to the beginning of a lower tier
        // Bronze: stays Bronze V (0)
        // Silver: -> Silver V
        // Gold: -> Silver V
        // Platinum: -> Gold V
        // Diamond: -> Platinum V
        // Master: -> Diamond V

        if (tier === 'Master') resetPoints = 1500 + 1500 + 2000 + 2500; // Diamond V base
        else if (tier === 'Diamond') resetPoints = 1500 + 1500 + 2000; // Platinum V base
        else if (tier === 'Platinum') resetPoints = 1500 + 1500; // Gold V base
        else if (tier === 'Gold') resetPoints = 1500; // Silver V base
        else if (tier === 'Silver') resetPoints = 1500; // Silver V base
        else resetPoints = 0;

        return {
            ranking_points: resetPoints,
            brave_points: 0
        };
    },

    async getOrCreateRanking(userId: any, activeSeason: any) {
        let ranking = await strapi.documents('api::ranking.ranking').findFirst({
            filters: {
                user_id: { id: userId },
                season: { documentId: activeSeason.documentId }
            },
        });

        if (!ranking) {
            const lastRanking = await strapi.documents('api::ranking.ranking').findFirst({
                filters: { user_id: userId },
                sort: 'createdAt:desc'
            });

            const { ranking_points, brave_points } = lastRanking
                ? this.calculateSoftReset((lastRanking as any).ranking_points || 0)
                : { ranking_points: 0, brave_points: 0 };

            const { rankStr, stars } = this.getRankInfoFromPoints(ranking_points);

            ranking = await strapi.documents('api::ranking.ranking').create({
                data: {
                    user_id: userId,
                    season: activeSeason.documentId,
                    ranking_points,
                    brave_points,
                    rank: rankStr,
                    stars,
                    match_played: 0,
                    win: 0,
                    lose: 0,
                    win_streak: 0,
                    point_for: 0,
                    point_against: 0
                },
                status: 'published'
            });
        }
        return ranking;
    },

    async recordMatch(winners: number[], losers: number[], winnerScore: number, loserScore: number, matchId: string) {
        const activeSeason = await this.getOrCreateCurrentSeason();

        const winnerRankings = await Promise.all(winners.map(id => this.getOrCreateRanking(id, activeSeason)));
        const loserRankings = await Promise.all(losers.map(id => this.getOrCreateRanking(id, activeSeason)));

        // Record Winners
        const updatedWinners = await Promise.all(winnerRankings.map(async (ranking, index) => {
            const userId = winners[index];
            const oldRp = (ranking as any).ranking_points || 0;
            const winStreak = (ranking.win_streak || 0) + 1;
            const bpGain = this.calculateBravePoints(true, Number(winnerScore), Number(loserScore), winStreak);

            let totalBp = (ranking.brave_points || 0) + bpGain;
            let rpGain = 100;
            if (totalBp >= BRAVE_POINTS_CAP) {
                rpGain += 100;
                totalBp -= BRAVE_POINTS_CAP;
            }

            const newRp = oldRp + rpGain;
            const { rankStr, stars } = this.getRankInfoFromPoints(newRp);

            const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                documentId: ranking.documentId,
                data: {
                    ranking_points: newRp,
                    brave_points: totalBp,
                    rank: rankStr,
                    stars: stars,
                    match_played: (ranking.match_played || 0) + 1,
                    win: (ranking.win || 0) + 1,
                    win_streak: winStreak,
                    point_for: (ranking.point_for || 0) + Number(winnerScore),
                    point_against: (ranking.point_against || 0) + Number(loserScore),
                },
                status: 'published',
            });

            await strapi.documents('api::match-history.match-history').create({
                data: {
                    users: [userId],
                    matches: [matchId],
                    old_rp: oldRp,
                    new_rp: newRp,
                    rp_change: rpGain,
                    ranking: (updatedRanking as any).documentId,
                    is_win: true
                },
                status: 'published',
            });

            return updatedRanking;
        }));

        // Record Losers
        const updatedLosers = await Promise.all(loserRankings.map(async (ranking, index) => {
            const userId = losers[index];
            const oldRp = (ranking as any).ranking_points || 0;
            const bpGain = this.calculateBravePoints(false, Number(winnerScore), Number(loserScore), 0);

            let totalBp = (ranking.brave_points || 0) + bpGain;
            let rpLoss = 100;
            if (totalBp >= BRAVE_POINTS_CAP) {
                rpLoss = 0; // Protection
                totalBp -= BRAVE_POINTS_CAP;
            }

            // Bronze floor protection
            let newRp = oldRp - rpLoss;
            if (newRp < 0) newRp = 0;

            const { rankStr, stars } = this.getRankInfoFromPoints(newRp);

            const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                documentId: ranking.documentId,
                data: {
                    ranking_points: newRp,
                    brave_points: totalBp,
                    rank: rankStr,
                    stars: stars,
                    match_played: (ranking.match_played || 0) + 1,
                    lose: (ranking.lose || 0) + 1,
                    win_streak: 0,
                    point_for: (ranking.point_for || 0) + Number(loserScore),
                    point_against: (ranking.point_against || 0) + Number(winnerScore),
                },
                status: 'published',
            });

            await strapi.documents('api::match-history.match-history').create({
                data: {
                    users: [userId],
                    matches: [matchId],
                    old_rp: oldRp,
                    new_rp: newRp,
                    rp_change: -rpLoss,
                    ranking: (updatedRanking as any).documentId,
                    is_win: false
                },
                status: 'published',
            });

            return updatedRanking;
        }));

        return { winners: updatedWinners, losers: updatedLosers };
    },

    async revertMatch(matchId: string) {
        const histories = await strapi.documents('api::match-history.match-history').findMany({
            filters: { matches: { documentId: matchId } },
            populate: ['users', 'ranking']
        });

        if (histories.length === 0) return { message: 'No history found to revert', reverted: 0 };

        const revertedResults = await Promise.all(histories.map(async (history: any) => {
            const ranking = history.ranking;
            if (!ranking) return null;

            const { rankStr, stars } = this.getRankInfoFromPoints(history.old_rp);

            const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                documentId: ranking.documentId,
                data: {
                    ranking_points: history.old_rp,
                    rank: rankStr,
                    stars: stars,
                    match_played: Math.max(0, (ranking.match_played || 0) - 1),
                    win: (history.is_win || (history.is_win === undefined && history.rp_change > 0)) ? Math.max(0, (ranking.win || 0) - 1) : ranking.win,
                    lose: (!history.is_win || (history.is_win === undefined && history.rp_change <= 0)) ? Math.max(0, (ranking.lose || 0) - 1) : ranking.lose,
                },
                status: 'published'
            });

            await strapi.documents('api::match-history.match-history').delete({
                documentId: history.documentId
            });

            return updatedRanking;
        }));

        return { revertedCount: revertedResults.filter(Boolean).length };
    },

    async getBalancedTeams(playerIds: number[]) {
        const activeSeason = await this.getOrCreateCurrentSeason();
        const playerRankings = await Promise.all(playerIds.map(id => this.getOrCreateRanking(id, activeSeason)));

        const players = playerRankings.map((r, i) => {
            const info = this.getRankInfoFromPoints((r as any).ranking_points);
            return {
                userId: playerIds[i],
                weight: info.weight,
                rank: info.rankStr
            };
        });

        const combinations = [
            { team1: [players[0], players[1]], team2: [players[2], players[3]] },
            { team1: [players[0], players[2]], team2: [players[1], players[3]] },
            { team1: [players[0], players[3]], team2: [players[1], players[2]] }
        ];

        let bestCombination = combinations[0];
        let minDiff = Infinity;

        for (const combo of combinations) {
            const team1Weight = combo.team1.reduce((sum, p) => sum + p.weight, 0);
            const team2Weight = combo.team2.reduce((sum, p) => sum + p.weight, 0);
            const diff = Math.abs(team1Weight - team2Weight);
            if (diff < minDiff) {
                minDiff = diff;
                bestCombination = combo;
            }
        }

        return { bestCombination, weightDiff: minDiff };
    },

    async getSeasonHistory(userId: number) {
        const activeSeason = await this.getOrCreateCurrentSeason();
        const ranking = await strapi.documents('api::ranking.ranking').findFirst({
            filters: {
                user_id: { id: userId },
                season: { documentId: activeSeason.documentId }
            }
        });

        if (!ranking) return [];

        return await strapi.documents('api::match-history.match-history').findMany({
            filters: { ranking: { documentId: ranking.documentId } },
            populate: ['matches', 'matches.team_a_id', 'matches.team_b_id', 'matches.team_winner'],
            sort: 'createdAt:desc'
        });
    },

    async resetCurrentSeason() {
        const activeSeason = await this.getOrCreateCurrentSeason();

        // 1. Get all rankings for current season
        const rankings = await strapi.documents('api::ranking.ranking').findMany({
            filters: { season: { documentId: activeSeason.documentId } },
            fields: ['documentId']
        });

        const ids = rankings.map(r => (r as any).documentId);

        // 2. Reset each ranking
        for (const docId of ids) {
            await strapi.documents('api::ranking.ranking').update({
                documentId: docId,
                data: {
                    ranking_points: 0,
                    brave_points: 0,
                    rank: 'Bronze V',
                    stars: 0,
                    match_played: 0,
                    win: 0,
                    lose: 0,
                    win_streak: 0,
                    point_for: 0,
                    point_against: 0
                } as any,
                status: 'published'
            });
        }

        // 3. Delete match histories for this season
        if (ids.length > 0) {
            const histories = await strapi.documents('api::match-history.match-history').findMany({
                filters: { ranking: { documentId: { $in: ids } } },
                fields: ['documentId']
            });

            for (const h of histories) {
                await strapi.documents('api::match-history.match-history').delete({
                    documentId: (h as any).documentId
                });
            }
            return { resetCount: ids.length, historyDeleted: histories.length };
        }

        return { resetCount: 0, historyDeleted: 0 };
    }
}));
