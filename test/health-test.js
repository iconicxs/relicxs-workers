#!/usr/bin/env node
require('dotenv').config();
const http = require('http');
const { server } = require('../src/health/server');

(async () => {
  try {
    // give server a moment
    await new Promise((r) => setTimeout(r, 500));
    http.get('http://127.0.0.1:8081/health', (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const obj = JSON.parse(data);
          console.log('HEALTH:', obj);
          if (typeof obj.redis_connected === 'undefined') throw new Error('invalid health');
          console.log('PASS: health endpoint');
          process.exit(0);
        } catch (e) { console.error('FAIL:', e); process.exit(1); }
      });
    }).on('error', (e) => { console.error('FAIL:', e); process.exit(1); });
  } catch (err) { console.error('FAIL:', err); process.exit(1); }
})();
