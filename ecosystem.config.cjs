module.exports = {
  apps: [
    {
      name: "pwa-forum-backend",
      script: "npm",
      args: "start",
      cwd: "/home/ubuntu/pwa-forum-backend",
      env: {
        NODE_ENV: "production",
        PORT: 3005,
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "/home/ubuntu/.pm2/logs/pwa-forum-backend-error.log",
      out_file: "/home/ubuntu/.pm2/logs/pwa-forum-backend-out.log",
      merge_logs: true,
    },
  ],
};
