/**
 * ranking controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::ranking.ranking', ({ strapi }) => {
    // Badminton specific ELO calculation considering Margin of Victory (MoV)
    function calculateBadmintonElo(ratingWinner: number, ratingLoser: number, scoreWinner: number, scoreLoser: number) {
        const K = 32;
        // Expected probability of the winner winning
        const expectedWinner = 1 / (1 + Math.pow(10, (ratingLoser - ratingWinner) / 400));

        // Margin of Victory multiplier
        const pointDiff = Math.max(scoreWinner - scoreLoser, 1);
        const movMultiplier = Math.log(pointDiff + 1);

        // Calculate how much rating changes based on K=32, the MoV, and the expected outcome gap
        const ratingChange = Math.round(K * movMultiplier * (1 - expectedWinner));

        return {
            newWinnerMmr: ratingWinner + ratingChange,
            newLoserMmr: ratingLoser - ratingChange
        };
    }

    const RANK_CONFIG = [
        { name: 'Bronze', maxStars: 3 },
        { name: 'Silver', maxStars: 3 },
        { name: 'Gold', maxStars: 4 },
        { name: 'Platinum', maxStars: 5 },
        { name: 'Diamond', maxStars: 5 },
        { name: 'Master', maxStars: 999999 }
    ];

    function calculateNewRankAndStars(currentRank: string | null, currentStars: number, isWin: boolean, winStreak: number) {
        let rankName = currentRank || "Bronze";
        let stars = currentStars || 0;
        
        let baseRankName = rankName.split(' ')[0];
        let rankIdx = RANK_CONFIG.findIndex(r => r.name === baseRankName);
        let config = RANK_CONFIG[rankIdx] || RANK_CONFIG[0];

        if (isWin) {
            let gain = 1;
            // Bonus star for win streak >= 3 in ranks Bronze to Platinum
            // winStreak here is the streak BEFORE this win, so if it's 2, this win makes it 3.
            const bonusRanks = ["Bronze", "Silver", "Gold", "Platinum"];
            if (winStreak >= 2 && bonusRanks.includes(baseRankName)) {
                gain = 2;
            }
            
            stars += gain;

            // Promotion logic (with star carry-over)
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
    }


    async function getOrCreateRanking(userId: any, activeSeason: any) {
        let ranking = await strapi.documents('api::ranking.ranking').findFirst({
            filters: {
                user_id: userId,
                season: {
                    documentId: activeSeason.documentId
                }
            },
        });

        if (!ranking) {
            // New season for this user - reset stats but carry over MMR
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
    }

    return {
        async upsert(ctx) {
            const requestBody = ctx.request.body || {};
            const body = requestBody.data || requestBody;
            const { user_id, ...updateData } = body;

            if (!user_id) {
                return ctx.badRequest('user_id is required');
            }

            try {
                // Auto-manage season
                const activeSeason = await strapi.service('api::ranking.ranking').getOrCreateCurrentSeason();

                const existingRanking = await strapi.documents('api::ranking.ranking').findFirst({
                    filters: {
                        user_id: user_id,
                        season: {
                            documentId: activeSeason.documentId
                        }
                    },
                });

                if (existingRanking) {
                    const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                        documentId: existingRanking.documentId,
                        data: updateData,
                        status: 'published'
                    });
                    return ctx.send({ data: updatedRanking });
                } else {
                    const newRanking = await strapi.documents('api::ranking.ranking').create({
                        data: { ...updateData, user_id: user_id, season: activeSeason.documentId },
                        status: 'published'
                    });
                    return ctx.send({ data: newRanking });
                }
            } catch (err) {
                return ctx.internalServerError(err.message);
            }
        },

        async recordMatch(ctx) {
            const requestBody = ctx.request.body || {};
            const body = requestBody.data || requestBody;
            const { winners, losers, winner_score, loser_score, match_id } = body;

            if (!winners || !losers || winner_score === undefined || loser_score === undefined || match_id === undefined) {
                return ctx.badRequest('winners, losers, winner_score, loser_score, and match_id are required');
            }

            try {
                // Auto-manage season
                const activeSeason = await strapi.service('api::ranking.ranking').getOrCreateCurrentSeason();

                const winnerRankings = await Promise.all(winners.map(id => getOrCreateRanking(id, activeSeason)));
                const loserRankings = await Promise.all(losers.map(id => getOrCreateRanking(id, activeSeason)));

                const winnerTeamMmr = winnerRankings.reduce((sum, r) => sum + r.mmr, 0) / winnerRankings.length;
                const loserTeamMmr = loserRankings.reduce((sum, r) => sum + r.mmr, 0) / loserRankings.length;

                const { newWinnerMmr: expectedWinnerTeamMmr, newLoserMmr: expectedLoserTeamMmr } = calculateBadmintonElo(
                    winnerTeamMmr,
                    loserTeamMmr,
                    Number(winner_score),
                    Number(loser_score)
                );

                const winnerMmrDelta = expectedWinnerTeamMmr - winnerTeamMmr;
                const loserMmrDelta = expectedLoserTeamMmr - loserTeamMmr;

                const updatedWinners = await Promise.all(winnerRankings.map(async (ranking, index) => {
                    const userId = winners[index];
                    const oldMmr = ranking.mmr;
                    const changeMmr = Math.round(winnerMmrDelta);
                    const newMmr = oldMmr + changeMmr;

                    const { rank, stars } = calculateNewRankAndStars(ranking.rank, ranking.stars || 0, true, ranking.win_streak || 0);

                    const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                        documentId: ranking.documentId,
                        data: {
                            mmr: newMmr,
                            rank,
                            stars,
                            match_played: (ranking.match_played || 0) + 1,
                            win: (ranking.win || 0) + 1,
                            win_streak: (ranking.win_streak || 0) + 1,
                            point_for: (ranking.point_for || 0) + Number(winner_score),
                            point_against: (ranking.point_against || 0) + Number(loser_score),
                        },
                        status: 'published',
                    });

                    await strapi.documents('api::match-history.match-history').create({
                        data: {
                            users: [userId],
                            matches: match_id ? [match_id] : [],
                            old_mmr: oldMmr,
                            new_mmr: newMmr,
                            mmr_change: changeMmr,
                            ranking: updatedRanking.documentId
                        } as any,
                        status: 'published'
                    });

                    return updatedRanking;
                }));

                const updatedLosers = await Promise.all(loserRankings.map(async (ranking, index) => {
                    const userId = losers[index];
                    const oldMmr = ranking.mmr;
                    const changeMmr = Math.round(loserMmrDelta);
                    const newMmr = oldMmr + changeMmr;

                    const { rank, stars } = calculateNewRankAndStars(ranking.rank, ranking.stars || 0, false, ranking.win_streak || 0);

                    const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                        documentId: ranking.documentId,
                        data: {
                            mmr: newMmr,
                            rank,
                            stars,
                            match_played: (ranking.match_played || 0) + 1,
                            lose: (ranking.lose || 0) + 1,
                            win_streak: 0,
                            point_for: (ranking.point_for || 0) + Number(loser_score),
                            point_against: (ranking.point_against || 0) + Number(winner_score),
                        },
                        status: 'published',
                    });

                    await strapi.documents('api::match-history.match-history').create({
                        data: {
                            users: [userId],
                            matches: match_id ? [match_id] : [],
                            old_mmr: oldMmr,
                            new_mmr: newMmr,
                            mmr_change: changeMmr,
                            ranking: updatedRanking.documentId
                        } as any,
                        status: 'published'
                    });

                    return updatedRanking;
                }));

                return ctx.send({
                    data: {
                        winners: updatedWinners,
                        losers: updatedLosers
                    }
                });

            } catch (err) {
                return ctx.internalServerError(err.message);
            }
        },

        async revertMatch(ctx) {
            const requestBody = ctx.request.body || {};
            const body = requestBody.data || requestBody;
            const { match_id } = body;

            if (!match_id) {
                return ctx.badRequest('match_id is required');
            }

            try {
                const match = await strapi.documents('api::match.match').findOne({
                    documentId: match_id,
                    populate: ['team_a_id', 'team_b_id', 'team_a_id.team_players', 'team_b_id.team_players', 'team_a_id.team_players.user_id', 'team_b_id.team_players.user_id']
                });

                if (!match) {
                    return ctx.notFound('Match not found');
                }

                const histories = await strapi.documents('api::match-history.match-history').findMany({
                    filters: {
                        matches: {
                            documentId: match_id
                        }
                    },
                    populate: ['users', 'ranking']
                });

                if (histories.length === 0) {
                    return ctx.send({ message: 'No history found to revert', reverted: 0 });
                }

                const revertedResults = await Promise.all(histories.map(async (history: any) => {
                    const user = history.users?.[0];
                    if (!user) return null;

                    let ranking;
                    if (history.ranking) {
                        ranking = history.ranking;
                    } else {
                        // Legacy fallback
                        ranking = await strapi.documents('api::ranking.ranking').findFirst({
                            filters: { user_id: user.id }
                        });
                    }

                    if (!ranking) return null;

                    const wasWinner = history.mmr_change > 0;
                    const wasLoser = history.mmr_change < 0;

                    const isTeamA = match.team_a_id?.team_players?.some(tp => tp.user_id?.id === user.id);
                    const userScore = isTeamA ? Number(match.score_a) : Number(match.score_b);
                    const opponentScore = isTeamA ? Number(match.score_b) : Number(match.score_a);

                    const { rank, stars } = calculateNewRankAndStars(ranking.rank, ranking.stars || 0, !wasWinner, 0);

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

                return ctx.send({
                    message: 'Match stats reverted successfully',
                    revertedCount: revertedResults.filter(r => r !== null).length
                });

            } catch (err) {
                return ctx.internalServerError(err.message);
            }
        }
    };
});
