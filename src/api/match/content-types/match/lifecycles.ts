
export default {
    async afterUpdate(event) {
        const { result, params } = event;
        
        // We need to compare with previous state to avoid redundant updates
        // However, in afterUpdate, we don't have the "before" state easily unless we fetch it in beforeUpdate.
        // For simplicity and reliability in this specific use case:
        // We check if status is 'done' and if match history already exists for this match.
        
        if (result.match_status === 'done') {
            // 1. Record stats for Ranking
            try {
                const history = await strapi.documents('api::match-history.match-history').findFirst({
                    filters: { matches: { documentId: result.documentId } }
                });

                if (!history) {
                    console.log(`[Lifecycle] Recording match stats for ${result.documentId}`);
                    await recordMatchStats(result.documentId);
                }
            } catch (err) {
                console.error(`[Lifecycle] Error recording match stats:`, err);
            }

            // 2. Knockout Advancement Logic
            try {
                const matchData = await strapi.documents('api::match.match').findOne({
                    documentId: result.documentId || params?.where?.documentId,
                    populate: {
                        tournament_id: true,
                        team_winner: true,
                        team_a_id: { populate: { team_players: { populate: { user_id: true } } } },
                        team_b_id: { populate: { team_players: { populate: { user_id: true } } } }
                    }
                } as any);

                if ((matchData as any)?.tournament_id?.format === 'knockout') {
                    const currentRound = parseInt(String(matchData.round || "1"));
                    const currentMatchNo = parseInt(String(matchData.match_no || "1"));
                    const nextRound = currentRound + 1;
                    const nextMatchNo = Math.ceil(currentMatchNo / 2);
                    const isTeamA = currentMatchNo % 2 !== 0;

                    let winnerTeam = (matchData as any).team_winner;
                    if (!winnerTeam) {
                        const sA = matchData.score_a || 0;
                        const sB = matchData.score_b || 0;
                        if (sA > sB) winnerTeam = (matchData as any).team_a_id;
                        else if (sB > sA) winnerTeam = (matchData as any).team_b_id;
                    }

                    if (winnerTeam) {
                        const tournamentDocId = (matchData as any).tournament_id.documentId;
                        const nextMatches = await strapi.documents('api::match.match').findMany({
                            filters: {
                                tournament_id: { documentId: tournamentDocId },
                                round: nextRound,
                                match_no: nextMatchNo
                            }
                        });

                        const nextMatch = nextMatches[0];
                        if (nextMatch) {
                            console.log(`[Knockout] Advancing winner to R${nextRound} M${nextMatchNo}`);
                            
                            // Create NEW team for next round
                            const newTeamRes = await strapi.documents('api::team.team').create({
                                data: {
                                    tournament_id: tournamentDocId,
                                    team_no: `R${nextRound}-M${nextMatchNo}-${isTeamA ? 'A' : 'B'}`
                                }
                            } as any);

                            const newTeamDocId = (newTeamRes as any).documentId;

                            // Fetch winner players from our already populated matchData
                            const playersToCopy = winnerTeam.team_players || [];
                            
                            for (const tp of playersToCopy) {
                                const userDocId = tp.user_id?.documentId || tp.user_id?.id;
                                if (userDocId) {
                                    await strapi.documents('api::team-player.team-player').create({
                                        data: {
                                            team_id: newTeamDocId,
                                            user_id: userDocId
                                        }
                                    } as any);
                                }
                            }

                            // Update next match
                            await strapi.documents('api::match.match').update({
                                documentId: nextMatch.documentId,
                                data: isTeamA ? { team_a_id: newTeamDocId } : { team_b_id: newTeamDocId }
                            });
                            
                            console.log(`[Knockout] Advancement complete for ${newTeamDocId}`);
                        }
                    }
                }
            } catch (err) {
                console.error(`[Lifecycle] Error in Knockout Advancement:`, err);
            }
        } else if (result.match_status === 'upcoming' || result.match_status === 'cancelled') {
            // If match was previously done, we should revert stats
            const history = await strapi.documents('api::match-history.match-history').findFirst({
                filters: { matches: { documentId: result.documentId } }
            });

            if (history) {
                console.log(`[Lifecycle] Reverting match ${result.documentId} stats...`);
                await strapi.service('api::ranking.ranking').revertMatch(result.documentId);
            }
        }
    },

    async beforeDelete(event) {
        const { params } = event;
        const documentId = params.where.documentId || params.where.id;
        
        if (documentId) {
            // Revert stats before deleting the match
            const history = await strapi.documents('api::match-history.match-history').findFirst({
                filters: { matches: { documentId: documentId } }
            });

            if (history) {
                console.log(`[Lifecycle] Reverting match ${documentId} stats before deletion...`);
                await strapi.service('api::ranking.ranking').revertMatch(documentId);
            }
        }
    }
};

async function recordMatchStats(matchId) {
    const match = await strapi.db.query('api::match.match').findOne({
        where: { documentId: matchId },
        populate: ['tournament_id', 'team_a_id.team_players.user_id', 'team_b_id.team_players.user_id', 'team_winner']
    });

    if (!match || !match.tournament_id) return;

    // Only record for tournaments in 'ranking' mode
    if (match.tournament_id.mode !== 'ranking') return;

    const winnerId = match.team_winner?.documentId;
    const winnerIdNum = match.team_winner?.id;
    if (!winnerId && !winnerIdNum) return;

    const isWinnerA = (winnerId && winnerId === match.team_a_id?.documentId) || (winnerIdNum && winnerIdNum === match.team_a_id?.id);
    const winnerTeam = isWinnerA ? match.team_a_id : match.team_b_id;
    const loserTeam = isWinnerA ? match.team_b_id : match.team_a_id;

    // Use Set to remove duplicate IDs caused by Strapi drafts
    const winners = Array.from(new Set(winnerTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []));
    const losers = Array.from(new Set(loserTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []));

    const winnerScore = isWinnerA ? match.score_a : match.score_b;
    const loserScore = isWinnerA ? match.score_b : match.score_a;

    if (winners.length > 0 && losers.length > 0) {
        await strapi.service('api::ranking.ranking').recordMatch(
            winners,
            losers,
            winnerScore,
            loserScore,
            matchId
        );
    }
}
