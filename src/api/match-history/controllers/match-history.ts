/**
 * match-history controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::match-history.match-history', ({ strapi }) => ({
  async analytics(ctx) {
    try {
      const { userId, seasonId } = ctx.query;

      if (!userId) {
        return ctx.badRequest('userId is required');
      }

      // Build filters
      const filters: any = {
        users: {
          id: { $eq: userId }
        }
      };

      if (seasonId && seasonId !== 'all') {
        // 1. Fetch ranking for this season and user to avoid deep nested filtering bugs
        const rankings: any = await strapi.entityService.findMany('api::ranking.ranking', {
          filters: {
            user_id: { id: { $eq: userId } },
            season: { documentId: { $eq: seasonId } }
          } as any
        });

        if (rankings && rankings.length > 0) {
          filters.ranking = {
            id: { $eq: rankings[0].id }
          };
        } else {
          // Return empty if no ranking exists for this season
          ctx.body = { data: { summary: [], details: {} } };
          return;
        }
      }

      // Fetch histories from DB
      const histories = await strapi.entityService.findMany('api::match-history.match-history', {
        filters,
        sort: { createdAt: 'asc' }, // Sort oldest to newest
      });

      // Process Data
      const summaryMap = new Map();
      const detailsMap = new Map();

      if (histories && Array.isArray(histories)) {
        histories.forEach(h => {
          const date = new Date(h.createdAt);
          
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          const fullDate = `${year}-${month}-${day}`;
          const shortDate = `${day}/${month}`;
          
          const hours = String(date.getHours()).padStart(2, '0');
          const minutes = String(date.getMinutes()).padStart(2, '0');
          const timeStr = `${hours}:${minutes}`;

          // Details grouping
          if (!detailsMap.has(fullDate)) {
            detailsMap.set(fullDate, []);
          }
          detailsMap.get(fullDate).push({
            id: h.id,
            documentId: h.documentId,
            rp: h.new_rp,
            time: timeStr,
            is_win: h.is_win,
            rp_change: h.rp_change,
            fullDate
          });

          // Summary grouping (overwrites so it keeps the final RP of the day)
          summaryMap.set(fullDate, {
            date: shortDate,
            fullDate: fullDate,
            rp: h.new_rp,
            matchCount: detailsMap.get(fullDate).length
          });
        });
      }

      const summary = Array.from(summaryMap.values());
      const details = Object.fromEntries(detailsMap);

      ctx.body = {
        data: {
          summary,
          details
        }
      };
    } catch (err) {
      ctx.throw(500, err);
    }
  },

  async partnerAnalytics(ctx) {
    try {
      const { userId, seasonId } = ctx.query;
      const paginationParams = (ctx.query.pagination as any) || {};
      const pageStr = paginationParams.page || 1;
      const limitStr = paginationParams.pageSize || 10;

      if (!userId) {
        return ctx.badRequest('userId is required');
      }

      const targetUserId = parseInt(userId as string, 10);

      // Build filters
      const filters: any = {
        users: {
          id: { $eq: targetUserId }
        }
      };

      if (seasonId && seasonId !== 'all') {
        const rankings: any = await strapi.entityService.findMany('api::ranking.ranking', {
          filters: {
            user_id: { id: { $eq: targetUserId } },
            season: { documentId: { $eq: seasonId } }
          } as any
        });

        if (rankings && rankings.length > 0) {
          filters.ranking = {
            id: { $eq: rankings[0].id }
          };
        } else {
          return { data: [], meta: { pagination: { page: Number(pageStr), pageSize: Number(limitStr), total: 0, pageCount: 0 } } };
        }
      }

      // Fetch ALL histories for the user to aggregate correctly (using limit 10000 to bypass default 100 limit)
      const histories = await strapi.entityService.findMany('api::match-history.match-history', {
        filters,
        limit: 10000,
        populate: {
          matches: {
            populate: {
              team_a_id: {
                populate: {
                  team_players: {
                    populate: {
                      user_id: {
                        populate: { picture: true }
                      }
                    }
                  }
                }
              },
              team_b_id: {
                populate: {
                  team_players: {
                    populate: {
                      user_id: {
                        populate: { picture: true }
                      }
                    }
                  }
                }
              }
            }
          }
        } as any,
      });

      const partnerStats: Record<number, any> = {};

      if (histories && Array.isArray(histories)) {
        histories.forEach(h => {
          const isWin = h.is_win;
          const matches = (h as any).matches || [];
          
          matches.forEach((match: any) => {
            const teamA = match.team_a_id?.team_players || [];
            const teamB = match.team_b_id?.team_players || [];
            
            const inTeamA = teamA.some((p: any) => p.user_id?.id === targetUserId);
            const inTeamB = teamB.some((p: any) => p.user_id?.id === targetUserId);
            
            let myTeam: any[] = [];
            if (inTeamA) myTeam = teamA;
            else if (inTeamB) myTeam = teamB;
            
            if (myTeam.length === 2) {
              const partner = myTeam.find((p: any) => p.user_id && p.user_id.id !== targetUserId);
              if (partner && partner.user_id) {
                const pid = partner.user_id.id;
                if (!partnerStats[pid]) {
                  partnerStats[pid] = {
                    partnerId: pid,
                    username: partner.user_id.username,
                    picture: partner.user_id.picture?.url || null,
                    matchesPlayed: 0,
                    wins: 0
                  };
                }
                partnerStats[pid].matchesPlayed += 1;
                if (isWin) {
                  partnerStats[pid].wins += 1;
                }
              }
            }
          });
        });
      }

      let partnerList = Object.values(partnerStats).map((p: any) => ({
        ...p,
        winRate: Math.round((p.wins / p.matchesPlayed) * 100)
      }));

      // Show everyone even if they played 1 time (>= 1)
      partnerList = partnerList.filter((p: any) => p.matchesPlayed >= 1);

      // Sort
      partnerList.sort((a: any, b: any) => {
        if (b.winRate !== a.winRate) return b.winRate - a.winRate;
        return b.matchesPlayed - a.matchesPlayed;
      });

      // Paginate manually
      const parsedPage = parseInt(String(pageStr), 10) || 1;
      const parsedLimit = parseInt(String(limitStr), 10) || 10;
      
      const total = partnerList.length;
      const pageCount = Math.ceil(total / parsedLimit) || 1;
      const startIndex = (parsedPage - 1) * parsedLimit;
      const paginatedPartners = partnerList.slice(startIndex, startIndex + parsedLimit);

      ctx.body = {
        data: paginatedPartners,
        meta: {
          pagination: {
            page: parsedPage,
            pageSize: parsedLimit,
            total,
            pageCount
          }
        }
      };
    } catch (err) {
      ctx.throw(500, err);
    }
  },

  async nemesisAnalytics(ctx) {
    try {
      const { userId, seasonId } = ctx.query;
      const paginationParams = (ctx.query.pagination as any) || {};
      const pageStr = paginationParams.page || 1;
      const limitStr = paginationParams.pageSize || 10;

      if (!userId) {
        return ctx.badRequest('userId is required');
      }

      const targetUserId = parseInt(userId as string, 10);

      // Build filters
      const filters: any = {
        users: {
          id: { $eq: targetUserId }
        }
      };

      if (seasonId && seasonId !== 'all') {
        const rankings: any = await strapi.entityService.findMany('api::ranking.ranking', {
          filters: {
            user_id: { id: { $eq: targetUserId } },
            season: { documentId: { $eq: seasonId } }
          } as any
        });

        if (rankings && rankings.length > 0) {
          filters.ranking = {
            id: { $eq: rankings[0].id }
          };
        } else {
          return { data: [], meta: { pagination: { page: Number(pageStr), pageSize: Number(limitStr), total: 0, pageCount: 0 } } };
        }
      }

      // Fetch ALL histories for the user to aggregate correctly (using limit 10000)
      const histories = await strapi.entityService.findMany('api::match-history.match-history', {
        filters,
        limit: 10000,
        populate: {
          matches: {
            populate: {
              team_a_id: {
                populate: {
                  team_players: {
                    populate: {
                      user_id: {
                        populate: { picture: true }
                      }
                    }
                  }
                }
              },
              team_b_id: {
                populate: {
                  team_players: {
                    populate: {
                      user_id: {
                        populate: { picture: true }
                      }
                    }
                  }
                }
              }
            }
          }
        } as any,
      });

      const nemesisStats: Record<number, any> = {};

      if (histories && Array.isArray(histories)) {
        histories.forEach(h => {
          const isWin = h.is_win;
          const matches = (h as any).matches || [];
          
          matches.forEach((match: any) => {
            const teamA = match.team_a_id?.team_players || [];
            const teamB = match.team_b_id?.team_players || [];
            
            const inTeamA = teamA.some((p: any) => p.user_id?.id === targetUserId);
            const inTeamB = teamB.some((p: any) => p.user_id?.id === targetUserId);
            
            let opponentsTeam: any[] = [];
            if (inTeamA) opponentsTeam = teamB;
            else if (inTeamB) opponentsTeam = teamA;
            
            opponentsTeam.forEach((p: any) => {
              if (p.user_id && p.user_id.id !== targetUserId) {
                const oid = p.user_id.id;
                if (!nemesisStats[oid]) {
                  nemesisStats[oid] = {
                    opponentId: oid,
                    username: p.user_id.username,
                    picture: p.user_id.picture?.url || null,
                    matchesPlayed: 0,
                    wins: 0 // Wins for the TARGET USER against this opponent
                  };
                }
                nemesisStats[oid].matchesPlayed += 1;
                // If the target user won this match, increment wins against this opponent
                if (isWin) {
                  nemesisStats[oid].wins += 1;
                }
              }
            });
          });
        });
      }

      let nemesisList = Object.values(nemesisStats).map((n: any) => ({
        ...n,
        winRate: Math.round((n.wins / n.matchesPlayed) * 100),
        losses: n.matchesPlayed - n.wins // Number of times target user LOST against this opponent
      }));

      // Show everyone even if played once
      nemesisList = nemesisList.filter((n: any) => n.matchesPlayed >= 1);

      // Sort by Win Rate ASCENDING (lowest win rate first)
      // If win rates are equal, sort by Losses DESCENDING (highest losses first)
      nemesisList.sort((a: any, b: any) => {
        if (a.winRate !== b.winRate) return a.winRate - b.winRate;
        return b.losses - a.losses;
      });

      // Paginate manually
      const parsedPage = parseInt(String(pageStr), 10) || 1;
      const parsedLimit = parseInt(String(limitStr), 10) || 10;
      
      const total = nemesisList.length;
      const pageCount = Math.ceil(total / parsedLimit) || 1;
      const startIndex = (parsedPage - 1) * parsedLimit;
      const paginatedNemesis = nemesisList.slice(startIndex, startIndex + parsedLimit);

      ctx.body = {
        data: paginatedNemesis,
        meta: {
          pagination: {
            page: parsedPage,
            pageSize: parsedLimit,
            total,
            pageCount
          }
        }
      };
    } catch (err) {
      ctx.throw(500, err);
    }
  }
}));
