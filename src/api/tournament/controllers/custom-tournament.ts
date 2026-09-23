/**
 * custom-tournament controller
 */

import { factories } from '@strapi/strapi';

async function getAuthUser(ctx: any) {
  if (ctx.state.user) return ctx.state.user;
  const authHeader = ctx.request.header.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const payload = await (strapi as any).plugin('users-permissions').service('jwt').verify(token);
      if (payload && payload.id) {
        return await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { id: payload.id }
        });
      }
    } catch (e) {
      return null;
    }
  }
  return null;
}

export default {
  async drawNext(ctx) {
    try {
      const { id } = ctx.params;
      const { pairingMode } = ctx.request.body.data || {};
      
      const service = strapi.service('api::tournament.custom-tournament');
      if (!service) {
        throw new Error("Custom tournament service not found");
      }
      
      const result = await service.drawNext(id, pairingMode);
      
      ctx.body = { data: result };
    } catch (err: any) {
      return ctx.badRequest(err.message);
    }
  },

  async createEndlessMatch(ctx) {
    try {
      const { id } = ctx.params;
      const { playerIdsA, playerIdsB } = ctx.request.body.data || {};
      
      const service = strapi.service('api::tournament.custom-tournament');
      const result = await (service as any).createMatchManual(id, playerIdsA, playerIdsB);
      
      ctx.body = { data: result };
    } catch (err: any) {
      return ctx.badRequest(err.message);
    }
  },

  async getMyBlockedPartner(ctx) {
    try {
      const user = await getAuthUser(ctx);
      if (!user) {
        return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');
      }

      const { id } = ctx.params;
      const tournament = (await strapi.db.query('api::tournament.tournament').findOne({
        where: {
          $or: [
            { documentId: id },
            ...(isNaN(Number(id)) ? [] : [{ id: Number(id) }])
          ]
        },
        populate: {
          tournament_players: {
            populate: {
              user: {
                populate: ['picture']
              }
            }
          }
        }
      })) as any;

      if (!tournament) {
        return ctx.notFound('ไม่พบทัวร์นาเมนต์นี้');
      }

      const blockedList: any[] = tournament.blocked_partners || [];
      const myBlock = blockedList.find(b => Number(b.blockerId) === Number(user.id));

      if (!myBlock) {
        return ctx.body = { data: null };
      }

      // Find details of the blocked player
      const tPlayers: any[] = tournament.tournament_players || [];
      let blockedPlayerInfo = null;

      for (const tp of tPlayers) {
        if (tp.user && Number(tp.user.id) === Number(myBlock.blockedId)) {
          blockedPlayerInfo = {
            id: tp.user.id,
            username: tp.user.username,
            nickname: tp.user.nickname,
            picture: tp.user.picture?.url || null,
            is_guest: false,
          };
          break;
        } else if (!tp.user && tp.guest_name && Number(-tp.id) === Number(myBlock.blockedId)) {
          blockedPlayerInfo = {
            id: -tp.id,
            username: tp.guest_name,
            nickname: tp.guest_name,
            picture: null,
            is_guest: true,
          };
          break;
        }
      }

      ctx.body = {
        data: {
          blockedId: myBlock.blockedId,
          blockedPlayer: blockedPlayerInfo,
          createdAt: myBlock.createdAt,
        }
      };
    } catch (err: any) {
      return ctx.badRequest(err.message);
    }
  },

  async setBlockedPartner(ctx) {
    try {
      const user = await getAuthUser(ctx);
      if (!user) {
        return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');
      }

      const { id } = ctx.params;
      const { targetPlayerId } = ctx.request.body?.data || {};

      if (targetPlayerId === undefined || targetPlayerId === null) {
        return ctx.badRequest('กรุณาระบุผู้เล่นที่ต้องการบล็อค');
      }

      const targetIdNum = Number(targetPlayerId);
      if (targetIdNum === Number(user.id)) {
        return ctx.badRequest('ไม่สามารถบล็อคตัวเองได้');
      }

      const tournament = (await strapi.db.query('api::tournament.tournament').findOne({
        where: {
          $or: [
            { documentId: id },
            ...(isNaN(Number(id)) ? [] : [{ id: Number(id) }])
          ]
        },
        populate: {
          tournament_players: {
            populate: ['user']
          }
        }
      })) as any;

      if (!tournament) {
        return ctx.notFound('ไม่พบทัวร์นาเมนต์นี้');
      }

      const tPlayers: any[] = tournament.tournament_players || [];

      // Check if current user is registered in this tournament
      const isUserInTournament = tPlayers.some(tp => tp.user && Number(tp.user.id) === Number(user.id));
      if (!isUserInTournament) {
        return ctx.badRequest('คุณไม่ได้เข้าร่วมในทัวร์นาเมนต์นี้');
      }

      // Check if target exists in this tournament
      const targetInTournament = tPlayers.some(tp => {
        if (targetIdNum > 0) return tp.user && Number(tp.user.id) === targetIdNum;
        return !tp.user && Number(-tp.id) === targetIdNum;
      });

      if (!targetInTournament) {
        return ctx.badRequest('ไม่พบผู้เล่นนี้ในทัวร์นาเมนต์');
      }

      const currentBlocked: any[] = tournament.blocked_partners || [];

      // Rule 1: A user can block at most 1 person
      const myExistingBlock = currentBlocked.find(b => Number(b.blockerId) === Number(user.id));
      if (myExistingBlock && Number(myExistingBlock.blockedId) !== targetIdNum) {
        return ctx.badRequest('คุณใช้สิทธิ์เว้นคู่ครบ 1 คนแล้ว กรุณายกเลิกคนเดิมก่อนเลือกคนใหม่');
      }

      // Rule 2: Target limit based on tournament size N: max(1, floor((N - 1) / 3))
      const N = tPlayers.length;
      const maxTargetBlocks = Math.max(1, Math.floor((N - 1) / 3));

      const incomingBlocksCount = currentBlocked.filter(
        b => Number(b.blockedId) === targetIdNum && Number(b.blockerId) !== Number(user.id)
      ).length;

      if (incomingBlocksCount >= maxTargetBlocks) {
        return ctx.badRequest('ผู้เล่นท่านนี้ถึงขีดจำกัดการเว้นคู่ของทัวร์นาเมนต์แล้ว เพื่อรักษาระบบจัดคู่ลงสนาม');
      }

      // Update blocked list
      const updatedBlocked = currentBlocked.filter(b => Number(b.blockerId) !== Number(user.id));
      updatedBlocked.push({
        blockerId: user.id,
        blockedId: targetIdNum,
        createdAt: new Date().toISOString(),
      });

      const docId = tournament.documentId || id;
      if (docId) {
        await strapi.db.query('api::tournament.tournament').updateMany({
          where: { documentId: docId },
          data: { blocked_partners: updatedBlocked }
        });
        try {
          await (strapi as any).documents('api::tournament.tournament').update({
            documentId: docId,
            data: { blocked_partners: updatedBlocked },
            status: 'published'
          });
        } catch (e) {}
      } else {
        await strapi.db.query('api::tournament.tournament').update({
          where: { id: tournament.id },
          data: { blocked_partners: updatedBlocked }
        });
      }

      ctx.body = {
        data: {
          success: true,
          message: 'บันทึกการตั้งค่าเรียบร้อยแล้ว',
          blockedId: targetIdNum
        }
      };
    } catch (err: any) {
      return ctx.badRequest(err.message);
    }
  },

  async removeBlockedPartner(ctx) {
    try {
      const user = await getAuthUser(ctx);
      if (!user) {
        return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');
      }

      const { id } = ctx.params;
      const tournament = (await strapi.db.query('api::tournament.tournament').findOne({
        where: {
          $or: [
            { documentId: id },
            ...(isNaN(Number(id)) ? [] : [{ id: Number(id) }])
          ]
        }
      })) as any;

      if (!tournament) {
        return ctx.notFound('ไม่พบทัวร์นาเมนต์นี้');
      }

      const currentBlocked: any[] = tournament.blocked_partners || [];
      const updatedBlocked = currentBlocked.filter(b => Number(b.blockerId) !== Number(user.id));

      const docId = tournament.documentId || id;
      if (docId) {
        await strapi.db.query('api::tournament.tournament').updateMany({
          where: { documentId: docId },
          data: { blocked_partners: updatedBlocked }
        });
        try {
          await (strapi as any).documents('api::tournament.tournament').update({
            documentId: docId,
            data: { blocked_partners: updatedBlocked },
            status: 'published'
          });
        } catch (e) {}
      } else {
        await strapi.db.query('api::tournament.tournament').update({
          where: { id: tournament.id },
          data: { blocked_partners: updatedBlocked }
        });
      }

      ctx.body = {
        data: {
          success: true,
          message: 'ปลดบล็อคเรียบร้อยแล้ว'
        }
      };
    } catch (err: any) {
      return ctx.badRequest(err.message);
    }
  }
};
