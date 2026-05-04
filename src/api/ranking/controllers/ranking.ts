import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::ranking.ranking', ({ strapi }) => ({
    async upsert(ctx) {
        const requestBody = ctx.request.body || {};
        const body = requestBody.data || requestBody;
        const { user_id, ...updateData } = body;

        if (!user_id) {
            return ctx.badRequest('user_id is required');
        }

        try {
            const activeSeason = await strapi.service('api::ranking.ranking').getOrCreateCurrentSeason();

            const existingRanking = await strapi.documents('api::ranking.ranking').findFirst({
                filters: {
                    user_id: user_id,
                    season: { documentId: activeSeason.documentId }
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
            const result = await strapi.service('api::ranking.ranking').recordMatch(
                winners,
                losers,
                Number(winner_score),
                Number(loser_score),
                match_id
            );
            return ctx.send({ data: result });
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
            const result = await strapi.service('api::ranking.ranking').revertMatch(match_id);
            return ctx.send({ data: result });
        } catch (err) {
            return ctx.internalServerError(err.message);
        }
    },

    async fixProduction(ctx) {
        try {
            console.log("🚀 Starting Production Score Recovery via API...");
            
            const matches = await strapi.db.query('api::match.match').findMany({
                where: { match_status: 'done' },
                orderBy: { updatedAt: 'asc' },
                populate: ['tournament_id', 'team_a_id.team_players.user_id', 'team_b_id.team_players.user_id', 'team_winner']
            });
            
            let fixedCount = 0;
            
            for (const match of matches) {
                if (match.tournament_id?.mode !== 'ranking') continue;
                
                const historyCount = await strapi.db.query('api::match-history.match-history').count({
                    where: { matches: match.id }
                });
                
                if (historyCount === 0) {
                    const winnerId = match.team_winner?.documentId || match.team_winner?.id;
                    const isWinnerA = winnerId === (match.team_a_id?.documentId || match.team_a_id?.id);
                    const winnerTeam = isWinnerA ? match.team_a_id : match.team_b_id;
                    const loserTeam = isWinnerA ? match.team_b_id : match.team_a_id;

                    const winners = Array.from(new Set(winnerTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []));
                    const losers = Array.from(new Set(loserTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []));

                    if (winners.length > 0 && losers.length > 0) {
                        await strapi.service('api::ranking.ranking').recordMatch(
                            winners, losers, match.score_a, match.score_b, match.documentId
                        );
                        fixedCount++;
                    }
                }
            }
            
            return ctx.send({ message: `Recovery Complete! Successfully fixed ${fixedCount} matches.` });
        } catch (err) {
            return ctx.internalServerError(err.message);
        }
    }
}));
