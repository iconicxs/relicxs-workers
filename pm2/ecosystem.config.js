module.exports = {
  apps: [
    {
      name: 'machinist-worker',
      script: 'src/workers/machinist/machinist.worker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      time: true,
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'archivist-worker',
      script: 'src/workers/archivist/archivist.worker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      time: true,
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'health-server',
      script: 'src/health/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      time: true,
      env: { NODE_ENV: 'production', HEALTH_PORT: 8081, MINIMAL_MODE: 'true' }
    }
  ]
};
