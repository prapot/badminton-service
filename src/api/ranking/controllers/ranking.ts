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
        // A safety check ensures difference is at least 1 (e.g. 21-20 -> diff 1, multiplier ln(2) ~ 0.69)
        // If difference is 7 (e.g. 21-14 -> diff 7, multiplier ln(8) ~ 2.07)
        const pointDiff = Math.max(scoreWinner - scoreLoser, 1);
        const movMultiplier = Math.log(pointDiff + 1);

        // Calculate how much rating changes based on K=32, the MoV, and the expected outcome gap
        const ratingChange = Math.round(K * movMultiplier * (1 - expectedWinner));

        return {
            newWinnerMmr: ratingWinner + ratingChange,
            newLoserMmr: ratingLoser - ratingChange
        };
    }

    return {
        async upsert(ctx) {
            // Attempt to get data from ctx.request.body.data or fallback to ctx.request.body
            const requestBody = ctx.request.body || {};
            const body = requestBody.data || requestBody;
            const { user_id, ...updateData } = body;

            if (!user_id) {
                return ctx.badRequest('user_id is required');
            }

            try {
                // Find existing ranking for this user_id
                const existingRanking = await strapi.documents('api::ranking.ranking').findFirst({
                    filters: { user_id: user_id },
                });

                if (existingRanking) {
                    // Update existing ranking
                    const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                        documentId: existingRanking.documentId,
                        data: updateData,
                        status: 'published'
                    });
                    return ctx.send({ data: updatedRanking });
                } else {
                    // Create new ranking
                    const newRanking = await strapi.documents('api::ranking.ranking').create({
                        data: { ...updateData, user_id: user_id },
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

            if (winners === losers) {
                return ctx.badRequest('winners and losers cannot be the same user');
            }

            if (typeof winner_score !== 'number' || typeof loser_score !== 'number') {
                return ctx.badRequest('winner_score and loser_score must be numbers');
            }

            if (winner_score < 0 || loser_score < 0) {
                return ctx.badRequest('scores cannot be negative');
            }

            if (winner_score <= loser_score) {
                return ctx.badRequest('winner_score must be strictly greater than loser_score');
            }

            try {
                // Helper to get or create ranking
                const getOrCreateRanking = async (userId: any) => {
                    let ranking = await strapi.documents('api::ranking.ranking').findFirst({
                        filters: { user_id: userId },
                    });
                    if (!ranking) {
                        ranking = await strapi.documents('api::ranking.ranking').create({
                            data: {
                                user_id: userId,
                                mmr: 1500,
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
                };

                const winnerRankings = await Promise.all(winners.map(id => getOrCreateRanking(id)));
                const loserRankings = await Promise.all(losers.map(id => getOrCreateRanking(id)));

                // Calculate average team MMR
                const winnerTeamMmr = winnerRankings.reduce((sum, r) => sum + r.mmr, 0) / winnerRankings.length;
                const loserTeamMmr = loserRankings.reduce((sum, r) => sum + r.mmr, 0) / loserRankings.length;

                // Calculate new MMRs using the scores based on team averages
                const { newWinnerMmr: expectedWinnerTeamMmr, newLoserMmr: expectedLoserTeamMmr } = calculateBadmintonElo(
                    winnerTeamMmr,
                    loserTeamMmr,
                    Number(winner_score),
                    Number(loser_score)
                );

                // The change is distributed equally (or appropriately) to all team members
                // We use the delta to apply to individual MMRs instead of assigning the team average
                const winnerMmrDelta = expectedWinnerTeamMmr - winnerTeamMmr;
                const loserMmrDelta = expectedLoserTeamMmr - loserTeamMmr;

                // Update winners
                const updatedWinners = await Promise.all(winnerRankings.map(async (ranking, index) => {
                    const userId = winners[index];
                    const oldMmr = ranking.mmr;
                    const changeMmr = Math.round(winnerMmrDelta);
                    const newMmr = oldMmr + changeMmr;

                    const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                        documentId: ranking.documentId,
                        data: {
                            mmr: newMmr,
                            match_played: (ranking.match_played || 0) + 1,
                            win: (ranking.win || 0) + 1,
                            win_streak: (ranking.win_streak || 0) + 1,
                            point_for: (ranking.point_for || 0) + Number(winner_score),
                            point_against: (ranking.point_against || 0) + Number(loser_score),
                        },
                        status: 'published',
                    });

                    // Create match history
                    await strapi.documents('api::match-history.match-history').create({
                        data: {
                            users: [userId],
                            matches: match_id ? [match_id] : [],
                            old_mmr: oldMmr,
                            new_mmr: newMmr,
                            mmr_change: changeMmr
                        },
                        status: 'published'
                    });

                    return updatedRanking;
                }));

                // Update losers
                const updatedLosers = await Promise.all(loserRankings.map(async (ranking, index) => {
                    const userId = losers[index];
                    const oldMmr = ranking.mmr;
                    const changeMmr = Math.round(loserMmrDelta);
                    const newMmr = oldMmr + changeMmr;

                    const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                        documentId: ranking.documentId,
                        data: {
                            mmr: newMmr,
                            match_played: (ranking.match_played || 0) + 1,
                            lose: (ranking.lose || 0) + 1,
                            win_streak: 0,
                            point_for: (ranking.point_for || 0) + Number(loser_score),
                            point_against: (ranking.point_against || 0) + Number(winner_score),
                        },
                        status: 'published',
                    });

                    // Create match history
                    await strapi.documents('api::match-history.match-history').create({
                        data: {
                            users: [userId],
                            matches: match_id ? [match_id] : [],
                            old_mmr: oldMmr,
                            new_mmr: newMmr,
                            mmr_change: changeMmr
                        },
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
        }
    };
});
