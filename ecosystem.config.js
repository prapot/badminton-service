module.exports = {
    apps: [
        {
            name: 'badminton-service',
            script: 'npm',
            args: 'start',
            cwd: '/root/www/badminton-service',
            env: {
                NODE_ENV: 'production',
                PORT: 1337,
                // Strapi reads only .env unless ENV_PATH is set — use the committed production env
                ENV_PATH: '/root/www/badminton-service/.env.production',
            },
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            error_file: '/var/log/pm2/badminton-service-error.log',
            out_file: '/var/log/pm2/badminton-service-out.log',
            merge_logs: true,
        },
    ],
};

