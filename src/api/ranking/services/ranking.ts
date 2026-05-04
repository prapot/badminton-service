import { factories } from '@strapi/strapi';

const RANK_CONFIG = [
    { name: 'Bronze', maxStars: 5 },
    { name: 'Silver', maxStars: 5 },
    { name: 'Gold', maxStars: 7 },
    { name: 'Platinum', maxStars: 8 },
    { name: 'Diamond', maxStars: 10 },
    { name: 'Master', maxStars: 999999 }
];

export default factories.createCoreService('api::ranking.ranking', ({ strapi }) => ({
    async getOrCreateCurrentSeason() {
        const now = new Date();
        const monthStr = now.toISOString().slice(0, 7); // "YYYY-MM"
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

    calculateBadmintonElo(ratingWinner: number, ratingLoser: number, scoreWinner: number, scoreLoser: number) {
        const K = 32;
        const expectedWinner = 1 / (1 + Math.pow(10, (ratingLoser - ratingWinner) / 400));
        const pointDiff = Math.max(scoreWinner - scoreLoser, 1);
        const movMultiplier = Math.log(pointDiff + 1);
        const ratingChange = Math.round(K * movMultiplier * (1 - expectedWinner));

        return {
            newWinnerMmr: ratingWinner + ratingChange,
            newLoserMmr: ratingLoser - ratingChange
        };
    },

    calculateNewRankAndStars(currentRank: string | null, currentStars: number, isWin: boolean, winStreak: number) {
        let rankName = currentRank || "Bronze";
        let stars = currentStars || 0;
        
        let baseRankName = rankName.split(' ')[0];
        let rankIdx = RANK_CONFIG.findIndex(r => r.name === baseRankName);
        let config = RANK_CONFIG[rankIdx] || RANK_CONFIG[0];

        if (isWin) {
            let gain = 1;
            const bonusRanks = ["Bronze", "Silver"];
            if (winStreak >= 2 && bonusRanks.includes(baseRankName)) {
                gain = 2;
            }
            
            stars += gain;

            while (stars > config.maxStars && rankName !== "Master") {
                const nextRank = RANK_CONFIG[rankIdx + 1];
                if (nextRank) {
                    stars -= config.maxStars;
                    rankName = nextRank.name;
                    rankIdx++;
                    config = RANK_CONFIG[rankIdx];
                    baseRankName = rankName;
                } else {
                    break;
                }
            }
        } else {
            if (baseRankName === "Bronze" && stars === 0) {
                stars = 0;
            } else {
                stars -= 1;
                if (stars < 0) {
                    if (rankIdx > 0) {
                        const prevRank = RANK_CONFIG[rankIdx - 1];
                        rankName = prevRank.name;
                        stars = prevRank.maxStars; 
                    } else {
                        stars = 0;
                    }
                }
            }
        }
        return { rank: rankName, stars };
    },

    async getOrCreateRanking(userId: any, activeSeason: any) {
        let ranking = await strapi.documents('api::ranking.ranking').findFirst({
            filters: {
                user_id: userId,
                season: { documentId: activeSeason.documentId }
            },
        });

        if (!ranking) {
            const lastRanking = await strapi.documents('api::ranking.ranking').findFirst({
                filters: { user_id: userId },
                sort: 'createdAt:desc'
            });

            const { rank, stars } = lastRanking ? { rank: lastRanking.rank, stars: lastRanking.stars } : { rank: 'Bronze', stars: 0 };

            ranking = await strapi.documents('api::ranking.ranking').create({
                data: {
                    user_id: userId,
                    season: activeSeason.documentId,
                    mmr: lastRanking ? lastRanking.mmr : 1500,
                    rank,
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
        let matchInternalId = null;
        if (matchId) {
            const matchEntity = await strapi.db.query('api::match.match').findOne({ where: { documentId: matchId } });
            if (matchEntity) matchInternalId = matchEntity.id;
        }

        const activeSeason = await this.getOrCreateCurrentSeason();

        const winnerRankings = await Promise.all(winners.map(id => this.getOrCreateRanking(id, activeSeason)));
        const loserRankings = await Promise.all(losers.map(id => this.getOrCreateRanking(id, activeSeason)));

        const winnerTeamMmr = winnerRankings.reduce((sum, r) => sum + r.mmr, 0) / winnerRankings.length;
        const loserTeamMmr = loserRankings.reduce((sum, r) => sum + r.mmr, 0) / loserRankings.length;

        const { newWinnerMmr: expectedWinnerTeamMmr, newLoserMmr: expectedLoserTeamMmr } = this.calculateBadmintonElo(
            winnerTeamMmr,
            loserTeamMmr,
            Number(winnerScore),
            Number(loserScore)
        );

        const winnerMmrDelta = expectedWinnerTeamMmr - winnerTeamMmr;
        const loserMmrDelta = expectedLoserTeamMmr - loserTeamMmr;

        const updatedWinners = await Promise.all(winnerRankings.map(async (ranking, index) => {
            const userId = winners[index];
            const oldMmr = ranking.mmr;
            const changeMmr = Math.round(winnerMmrDelta);
            const newMmr = oldMmr + changeMmr;

            const { rank, stars } = this.calculateNewRankAndStars(ranking.rank, ranking.stars || 0, true, ranking.win_streak || 0);

            const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                documentId: ranking.documentId,
                data: {
                    mmr: newMmr,
                    rank,
                    stars,
                    match_played: (ranking.match_played || 0) + 1,
                    win: (ranking.win || 0) + 1,
                    win_streak: (ranking.win_streak || 0) + 1,
                    point_for: (ranking.point_for || 0) + Number(winnerScore),
                    point_against: (ranking.point_against || 0) + Number(loserScore),
                },
                status: 'published',
            });

            try {
                await strapi.db.query('api::match-history.match-history').create({
                    data: {
                        users: [userId],
                        matches: matchInternalId ? [matchInternalId] : [],
                        old_mmr: oldMmr,
                        new_mmr: newMmr,
                        mmr_change: changeMmr,
                        ranking: updatedRanking.id,
                        publishedAt: new Date()
                    }
                });
            } catch (e) {
                console.error("FAILED CREATE HISTORY WINNERS:", e);
                throw e;
            }

            return updatedRanking;
        }));

        const updatedLosers = await Promise.all(loserRankings.map(async (ranking, index) => {
            const userId = losers[index];
            const oldMmr = ranking.mmr;
            const changeMmr = Math.round(loserMmrDelta);
            const newMmr = oldMmr + changeMmr;

            const { rank, stars } = this.calculateNewRankAndStars(ranking.rank, ranking.stars || 0, false, ranking.win_streak || 0);

            const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                documentId: ranking.documentId,
                data: {
                    mmr: newMmr,
                    rank,
                    stars,
                    match_played: (ranking.match_played || 0) + 1,
                    lose: (ranking.lose || 0) + 1,
                    win_streak: 0,
                    point_for: (ranking.point_for || 0) + Number(loserScore),
                    point_against: (ranking.point_against || 0) + Number(winnerScore),
                },
                status: 'published',
            });

            try {
                await strapi.db.query('api::match-history.match-history').create({
                    data: {
                        users: [userId],
                        matches: matchInternalId ? [matchInternalId] : [],
                        old_mmr: oldMmr,
                        new_mmr: newMmr,
                        mmr_change: changeMmr,
                        ranking: updatedRanking.id,
                        publishedAt: new Date()
                    }
                });
            } catch (e) {
                console.error("FAILED CREATE HISTORY LOSERS:", e);
                throw e;
            }

            return updatedRanking;
        }));

        return { winners: updatedWinners, losers: updatedLosers };
    },

    async revertMatch(matchId: string) {
        const histories = await strapi.documents('api::match-history.match-history').findMany({
            filters: {
                matches: { documentId: matchId }
            },
            populate: ['users', 'ranking', 'matches']
        });

        if (histories.length === 0) return { message: 'No history found to revert', reverted: 0 };

        // We need the match details for scores
        const match = await strapi.documents('api::match.match').findOne({
            documentId: matchId,
            populate: ['team_a_id', 'team_b_id', 'team_a_id.team_players', 'team_b_id.team_players', 'team_a_id.team_players.user_id', 'team_b_id.team_players.user_id']
        });

        if (!match) return { message: 'Match not found', reverted: 0 };

        const revertedResults = await Promise.all(histories.map(async (history: any) => {
            const user = history.users?.[0];
            if (!user) return null;

            const ranking = history.ranking || await strapi.documents('api::ranking.ranking').findFirst({
                filters: { user_id: user.id }
            });

            if (!ranking) return null;

            const wasWinner = history.mmr_change > 0;
            const wasLoser = history.mmr_change < 0;

            const isTeamA = match.team_a_id?.team_players?.some(tp => tp.user_id?.id === user.id);
            const userScore = isTeamA ? Number(match.score_a) : Number(match.score_b);
            const opponentScore = isTeamA ? Number(match.score_b) : Number(match.score_a);

            const { rank, stars } = this.calculateNewRankAndStars(ranking.rank, ranking.stars || 0, !wasWinner, 0);

            const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                documentId: ranking.documentId,
                data: {
                    mmr: history.old_mmr,
                    rank,
                    stars,
                    match_played: Math.max(0, (ranking.match_played || 0) - 1),
                    win: wasWinner ? Math.max(0, (ranking.win || 0) - 1) : ranking.win,
                    lose: wasLoser ? Math.max(0, (ranking.lose || 0) - 1) : ranking.lose,
                    win_streak: wasWinner ? Math.max(0, (ranking.win_streak || 0) - 1) : ranking.win_streak,
                    point_for: Math.max(0, (ranking.point_for || 0) - userScore),
                    point_against: Math.max(0, (ranking.point_against || 0) - opponentScore),
                },
                status: 'published'
            });

            await strapi.documents('api::match-history.match-history').delete({
                documentId: history.documentId
            });

            return updatedRanking;
        }));

        return {
            message: 'Match stats reverted successfully',
            revertedCount: revertedResults.filter(r => r !== null).length
        };
    }
}));
