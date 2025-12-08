module.exports = {
  apps: [
    {
      name: 'machinist-worker',
      script: 'src/workers/machinist/machinist.worker.js',
      cwd: '/var/www/relicxs-workers',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      time: true,
      env: { NODE_ENV: 'production' },
      env_production: { NODE_ENV: 'production' }
    },
    {
      name: 'archivist-worker',
      script: 'src/workers/archivist/archivist.worker.js',
      cwd: '/var/www/relicxs-workers',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      time: true,
      env: { NODE_ENV: 'production' },
      env_production: { NODE_ENV: 'production' }
    },
    {
      name: 'endpoints-server',
      script: 'src/endpoints/server.js',
      cwd: '/var/www/relicxs-workers',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      time: true,
      env: { NODE_ENV: 'production', HEALTH_PORT: 8081, MINIMAL_MODE: 'false' },
      env_production: { NODE_ENV: 'production', HEALTH_PORT: 8081, MINIMAL_MODE: 'false' }
    }
  ]
};
