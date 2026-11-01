export default {
    routes: [
        {
            // ต้องเปิดสิทธิ์ให้ role ใน Users & Permissions เอง (ปิดไว้ตั้งต้น) — ลบและคำนวณแต้มทั้งซีซั่นใหม่
            method: 'POST',
            path: '/rankings/recalibrate-season',
            handler: 'ranking.recalibrateSeason',
        },
        {
            method: 'GET',
            path: '/rankings/lifetime-stats',
            handler: 'ranking.getLifetimeStats',
            config: {
                auth: false
            }
        }
    ],
};
