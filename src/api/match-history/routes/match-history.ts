/**
 * match-history router
 */

import { factories } from '@strapi/strapi';

// อ่านอย่างเดียว: ข้อมูลนี้เขียนโดย ranking service (lifecycle ของ match) เท่านั้น
export default factories.createCoreRouter('api::match-history.match-history', {
    only: ['find', 'findOne'],
});
